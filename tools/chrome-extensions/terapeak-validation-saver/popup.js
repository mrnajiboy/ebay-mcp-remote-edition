const DEFAULT_BASE_URL = 'https://ebay-mcp.thousandstory.fyi';
const MARKETPLACE = 'EBAY-US';

const $ = (id) => document.getElementById(id);

function setStatus(message, type = 'info') {
  const el = $('status');
  el.className = `status ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''}`;
  el.textContent = message;
}

function normalizeBaseUrl(raw) {
  const value = (raw || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(value)) return `https://${value}`;
  return value;
}

async function loadOptions() {
  const saved = await chrome.storage.local.get(['baseUrl', 'adminKey', 'recordId', 'recordSearch']);
  $('baseUrl').value = saved.baseUrl || DEFAULT_BASE_URL;
  $('adminKey').value = saved.adminKey || '';
  $('recordId').value = saved.recordId || '';
  $('recordSearch').value = saved.recordSearch || '';
}

async function saveOptions() {
  await chrome.storage.local.set({
    baseUrl: normalizeBaseUrl($('baseUrl').value),
    adminKey: $('adminKey').value.trim(),
    recordId: $('recordId').value.trim(),
    recordSearch: $('recordSearch').value.trim()
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error('No active tab found.');
  return tab;
}

async function collectPageSnapshot(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'HANKUK_COLLECT_TERAPEAK_PAGE' }).catch(async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'HANKUK_COLLECT_TERAPEAK_PAGE' });
  });
  if (!response?.ok) throw new Error('Could not collect Terapeak page snapshot.');
  return response;
}

function toPlaywrightCookies(cookies) {
  return cookies.map((cookie) => {
    const sameSite = cookie.sameSite === 'no_restriction'
      ? 'None'
      : cookie.sameSite === 'lax'
        ? 'Lax'
        : cookie.sameSite === 'strict'
          ? 'Strict'
          : 'Lax';
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : -1,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite
    };
  });
}

async function collectStorageState() {
  const tab = await getActiveTab();
  const page = await collectPageSnapshot(tab.id);
  const cookies = await chrome.cookies.getAll({ domain: 'ebay.com' });
  if (!cookies.length) throw new Error('No ebay.com cookies found. Sign in to eBay first.');
  return {
    storageState: {
      cookies: toPlaywrightCookies(cookies),
      origins: [{ origin: 'https://www.ebay.com', localStorage: page.localStorage || [] }]
    },
    snapshot: page.snapshot
  };
}

function adminHeaders() {
  const adminKey = $('adminKey').value.trim();
  if (!adminKey) throw new Error('Admin API key is required.');
  return { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminKey };
}

async function requestAdmin(path, options = {}) {
  const baseUrl = normalizeBaseUrl($('baseUrl').value);
  const resp = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: adminHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || data.message || `HTTP ${resp.status}`);
  }
  return data;
}

function postAdmin(path, body) {
  return requestAdmin(path, { method: 'POST', body });
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeComparableQuery(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function searchTextMatchesQuery(searchText, pageQuery) {
  const haystack = normalizeComparableQuery(searchText);
  const terms = normalizeComparableQuery(pageQuery)
    .split(' ')
    .filter((term) => term.length > 2);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

async function hydrateSearchFromActivePage() {
  try {
    const tab = await getActiveTab();
    const snapshot = (await collectPageSnapshot(tab.id)).snapshot;
    const pageQuery = snapshot?.query?.trim();
    if (!pageQuery) return;

    const currentSearch = $('recordSearch').value.trim();
    if (normalizeComparableQuery(currentSearch) === normalizeComparableQuery(pageQuery)) return;

    $('recordSearch').value = pageQuery;
    if ($('recordId').value.trim() && currentSearch && !searchTextMatchesQuery(currentSearch, pageQuery)) {
      $('recordId').value = '';
    }
    $('recordResults').textContent = `Detected page query: ${pageQuery}. Click Search records.`;
    await saveOptions();
  } catch {
    // The popup can open on non-eBay/chrome pages where content-script injection is not allowed.
  }
}

function selectedFieldLines(summary, group) {
  const fields = (summary?.fields || []).filter((field) => field.group === group && field.field !== 'Last Data Snapshot');
  return fields.map((field) => {
    const marker = field.changed ? '•' : '·';
    const before = valueText(field.before);
    const after = valueText(field.after);
    return field.changed
      ? `${marker} ${field.field}: ${before} → ${after}`
      : `${marker} ${field.field}: ${after}`;
  });
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const stringValue = value.find((item) => typeof item === 'string' && item.trim());
      if (stringValue) return stringValue.trim();
    }
  }
  return null;
}

function formatTerapeakInsight(result, snapshot) {
  const debug = result?.result?.debug || {};
  const providerResolution = debug.providerResolution || {};
  const terapeak = debug.providers?.terapeak || {};
  const antiBot = terapeak.antiBotDetection || snapshot.terapeakAntiBotDetection || {};
  const soldFallbackUsed = providerResolution.soldFallbackUsed || snapshot.soldFallbackUsed;
  const fallbackReason = firstNonEmpty(
    providerResolution.fallbackReason,
    snapshot.terapeakFailureReason,
    terapeak.fallbackReasons,
    terapeak.currentPageErrors,
    terapeak.notes
  );

  const lines = [];
  if (fallbackReason || soldFallbackUsed || antiBot.detected || terapeak.authState || terapeak.sessionSource) {
    lines.push('Terapeak diagnostics:');
    if (soldFallbackUsed) lines.push('• Sold fallback used: yes');
    if (fallbackReason) lines.push(`• Reason: ${fallbackReason}`);
    if (antiBot.detected) {
      lines.push(`• eBay response: anti-bot challenge${antiBot.kind ? ` (${antiBot.kind})` : ''}`);
    }
    if (terapeak.authState || snapshot.terapeakAuthState) {
      lines.push(`• Auth state: ${terapeak.authState || snapshot.terapeakAuthState}`);
    }
    if (terapeak.sessionSource || snapshot.terapeakSessionSource) {
      lines.push(`• Session source: ${terapeak.sessionSource || snapshot.terapeakSessionSource}`);
    }
    if (terapeak.authValidationSucceeded !== undefined) {
      lines.push(`• Auth validation: ${terapeak.authValidationSucceeded ? 'passed' : 'failed'}`);
    }
    lines.push('');
  }
  return lines;
}

function formatValidationResult(result) {
  const summary = result.transferSummary;
  if (!summary) return JSON.stringify(result, null, 2);

  const snapshot = summary.snapshotSummary || {};
  const lines = [
    `Targeted validation complete for ${result.recordId}`,
    `Webhook: HTTP ${result.webhookStatus}`,
    `Changed Airtable fields: ${summary.changedFieldCount}`,
    ''
  ];

  if (snapshot.itemName || snapshot.effectiveSearchQuery) {
    lines.push('Context:');
    if (snapshot.itemName) lines.push(`• Item: ${snapshot.itemName}`);
    if (snapshot.effectiveSearchQuery) lines.push(`• Query: ${snapshot.effectiveSearchQuery}`);
    if (snapshot.activeSource) lines.push(`• Active source: ${snapshot.activeSource}`);
    if (snapshot.soldSource) lines.push(`• Sold source: ${snapshot.soldSource}`);
    lines.push('');
  }

  lines.push(...formatTerapeakInsight(result, snapshot));

  const activeLines = selectedFieldLines(summary, 'active');
  const soldLines = selectedFieldLines(summary, 'sold');
  const velocityLines = selectedFieldLines(summary, 'velocity');
  const metaLines = selectedFieldLines(summary, 'meta').filter((line) => !line.includes('Last Data Snapshot'));

  if (activeLines.length) lines.push('Active fields transferred/confirmed:', ...activeLines, '');
  if (soldLines.length) lines.push('Sold fields transferred/confirmed:', ...soldLines, '');
  if (velocityLines.length) lines.push('Velocity fields transferred/confirmed:', ...velocityLines, '');
  if (metaLines.length) lines.push('Run metadata:', ...metaLines, '');

  if (result.airtableRead && (!result.airtableRead.beforeOk || !result.airtableRead.afterOk)) {
    lines.push(`Airtable read warning: ${result.airtableRead.beforeError || result.airtableRead.afterError}`);
  }

  return lines.join('\n').trim();
}

async function searchRecords() {
  await saveOptions();
  const results = $('recordResults');
  const query = $('recordSearch').value.trim();
  results.textContent = 'Loading records...';
  const data = await requestAdmin(`/admin/validation/records?limit=25&query=${encodeURIComponent(query)}`);
  if (!data.records?.length) {
    results.textContent = 'No matching records.';
    return;
  }
  results.innerHTML = '';
  for (const record of data.records) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'record-option';
    button.textContent = record.label;
    const meta = document.createElement('small');
    meta.textContent = [record.searchQuery, record.trackingCadence].filter(Boolean).join(' · ');
    button.appendChild(meta);
    button.addEventListener('click', async () => {
      $('recordId').value = record.recordId;
      $('recordSearch').value = record.label;
      await saveOptions();
      setStatus(`Selected ${record.label}`, 'info');
    });
    results.appendChild(button);
  }
}

async function saveSession() {
  setStatus('Collecting eBay cookies/localStorage...', 'info');
  const { storageState } = await collectStorageState();
  setStatus(`Saving ${storageState.cookies.length} cookies to server session store...`, 'info');
  const result = await postAdmin('/admin/playwright-session', { marketplace: MARKETPLACE, storageState });
  return result;
}

async function rerunRecord(snapshotOverride = null) {
  const recordId = $('recordId').value.trim();
  if (!/^rec[A-Za-z0-9]+$/.test(recordId)) {
    throw new Error('Choose or paste a valid Airtable validation record ID beginning with rec.');
  }
  let snapshot = snapshotOverride;
  if (!snapshot) {
    const tab = await getActiveTab();
    snapshot = (await collectPageSnapshot(tab.id)).snapshot;
  }
  setStatus(`Sending targeted validation for ${recordId}...`, 'info');
  return postAdmin('/admin/validation/run-record', {
    recordId,
    validationId: recordId,
    providerOptions: {
      skipTwitter: true,
      manualTerapeakSnapshot: snapshot,
      manualTerapeakSnapshotSource: 'chrome_extension_visible_page'
    }
  });
}

async function withBusy(_buttonId, fn, formatter = (result) => JSON.stringify(result, null, 2)) {
  await saveOptions();
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await fn();
    setStatus(formatter(result), 'ok');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'err');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$('searchRecords').addEventListener('click', () => withBusy('searchRecords', searchRecords, () => 'Record search refreshed.'));
$('clearRecord').addEventListener('click', async () => {
  $('recordSearch').value = '';
  $('recordId').value = '';
  $('recordResults').textContent = 'Results appear as: recordID - Item';
  await saveOptions();
});
$('recordSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') withBusy('searchRecords', searchRecords, () => 'Record search refreshed.');
});
$('saveSession').addEventListener('click', () => withBusy('saveSession', saveSession));
$('rerunRecord').addEventListener('click', () => withBusy('rerunRecord', () => rerunRecord(), formatValidationResult));
$('saveAndRerun').addEventListener('click', () => withBusy('saveAndRerun', async () => {
  const { storageState, snapshot } = await collectStorageState();
  setStatus(`Saving ${storageState.cookies.length} cookies, then re-running record...`, 'info');
  const session = await postAdmin('/admin/playwright-session', { marketplace: MARKETPLACE, storageState });
  const validation = await rerunRecord(snapshot);
  return { ok: true, session, validation };
}, (result) => `Session saved.\n\n${formatValidationResult(result.validation)}`));

async function init() {
  await loadOptions();
  await hydrateSearchFromActivePage();
}

init().catch((error) => setStatus(String(error), 'err'));
