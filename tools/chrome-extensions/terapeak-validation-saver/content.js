(() => {
  function text() {
    return document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';
  }

  function numberAfter(patterns, source) {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (!match) continue;
      const raw = (match[1] || '').replace(/[$,%\s,]/g, '');
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function collectLocalStorage() {
    try {
      return Object.entries(localStorage).map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  }

  function extractTerapeakSnapshot() {
    const pageText = text();
    const url = new URL(location.href);
    const query = url.searchParams.get('keywords') || url.searchParams.get('query') || '';

    return {
      capturedAt: new Date().toISOString(),
      source: 'chrome_extension_visible_page',
      url: location.href,
      title: document.title,
      query,
      metrics: {
        activeListingsCount: numberAfter([
          /([\d,]+)\s+active listings?/i,
          /active listings?\s+([\d,]+)/i,
          /total active listings?\s+([\d,]+)/i
        ], pageText),
        soldListingsCount: numberAfter([
          /([\d,]+)\s+sold listings?/i,
          /sold listings?\s+([\d,]+)/i,
          /total sold\s+([\d,]+)/i
        ], pageText),
        soldAvgPriceUsd: numberAfter([
          /average sold price\s*\$?([\d,.]+)/i,
          /avg(?:\.|erage)? sold\s*\$?([\d,.]+)/i,
          /sold price\s*\$?([\d,.]+)/i
        ], pageText),
        activeAvgPriceUsd: numberAfter([
          /average listing price\s*\$?([\d,.]+)/i,
          /avg(?:\.|erage)? listing\s*\$?([\d,.]+)/i,
          /listing price\s*\$?([\d,.]+)/i
        ], pageText),
        soldSellThroughPct: numberAfter([
          /sell[-\s]?through\s*([\d,.]+)%/i,
          /([\d,.]+)%\s*sell[-\s]?through/i
        ], pageText),
        soldTotalRevenueUsd: numberAfter([
          /total sales\s*\$?([\d,.]+)/i,
          /total item sales\s*\$?([\d,.]+)/i,
          /sales total\s*\$?([\d,.]+)/i
        ], pageText)
      },
      pageTextSample: pageText.slice(0, 6000)
    };
  }

  function hasScrapeableQuery(snapshot) {
    const metrics = snapshot.metrics || {};
    const hasMetric = Object.values(metrics).some((value) => typeof value === 'number' && Number.isFinite(value));
    return Boolean(snapshot.query && (hasMetric || /terapeak|research|active listings?|sold listings?/i.test(snapshot.pageTextSample || '')));
  }

  function publishScrapeStatus() {
    try {
      const snapshot = extractTerapeakSnapshot();
      chrome.runtime.sendMessage({
        type: 'HANKUK_TERAPEAK_SCRAPE_STATUS',
        count: hasScrapeableQuery(snapshot) ? 1 : 0,
        query: snapshot.query || null
      });
    } catch {
      // Badge updates are best-effort; data collection still works via explicit popup action.
    }
  }

  let badgeTimer = null;
  function scheduleScrapeStatusPublish() {
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(publishScrapeStatus, 500);
  }

  publishScrapeStatus();
  if (document.body) {
    new MutationObserver(scheduleScrapeStatusPublish).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'HANKUK_COLLECT_TERAPEAK_PAGE') {
      sendResponse({ ok: true, snapshot: extractTerapeakSnapshot(), localStorage: collectLocalStorage() });
      return true;
    }
    return false;
  });
})();
