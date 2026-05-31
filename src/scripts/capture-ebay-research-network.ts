import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContextOptions, Response } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { ResearchStorageState } from '../validation/providers/ebay-research.js';
import { createFreshEbayResearchSessionStoreResolution } from '../validation/providers/ebay-research-session-store.js';

const RESEARCH_UI_URL = 'https://www.ebay.com/sh/research';
const RESEARCH_SEARCH_ENDPOINT = 'https://www.ebay.com/sh/research/api/search';
const DEFAULT_MARKETPLACE = 'EBAY-US';
const DEFAULT_TIMEZONE = process.env.EBAY_RESEARCH_TIMEZONE?.trim() || 'Asia/Seoul';
const DEFAULT_DAY_RANGE = 90;
const DEFAULT_LIMIT = 50;

interface CapturedResponse {
  capturedAt: string;
  url: string;
  sanitizedUrl: string;
  method: string;
  resourceType: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  bodyBytes: number;
  bodyExcerpt: string | null;
  jsonSummary: unknown;
  error: string | null;
}

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : null;
}

function getQuery(): string {
  const explicit = getArgValue('query');
  if (explicit) return explicit;
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  return positional?.trim() || 'stray kids skzoo plush';
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getChromiumChannel(): string | undefined {
  const channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
  return channel || undefined;
}

function isSensitiveHeader(name: string): boolean {
  return /cookie|authorization|token|secret|api[-_]?key|csrf|xsrf|session|credential/i.test(name);
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveHeader(key) ? '[REDACTED]' : value,
    ])
  );
}

function isSensitiveQueryParam(name: string): boolean {
  return /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authorization|session|sid|csrf|xsrf|credential|client[_-]?secret|api[_-]?key|secret|signature|sig)$/i.test(
    name
  );
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveQueryParam(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function isInterestingResponse(response: Response): boolean {
  const url = response.url();
  const req = response.request();
  const resourceType = req.resourceType();
  const headers = response.headers();
  const contentType = headers['content-type'] ?? '';

  return (
    url.includes('/sh/research') ||
    url.includes('/research/api/') ||
    url.includes('/api/search') ||
    /json|javascript|html/i.test(contentType) ||
    resourceType === 'xhr' ||
    resourceType === 'fetch'
  );
}

function summarizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: value.length > 0 ? summarizeJson(value[0]) : null,
    };
  }

  if (!value || typeof value !== 'object') {
    return { type: typeof value };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 50);
  const moduleNames = new Set<string>();
  const stack: unknown[] = [value];
  let inspected = 0;

  while (stack.length > 0 && inspected < 500) {
    inspected += 1;
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 25)) stack.push(item);
      continue;
    }
    const currentRecord = current as Record<string, unknown>;
    for (const [key, nested] of Object.entries(currentRecord)) {
      if (/module/i.test(key) && typeof nested === 'string') moduleNames.add(nested);
      if (key === 'modules' && Array.isArray(nested)) {
        for (const item of nested.slice(0, 50)) stack.push(item);
      } else if (nested && typeof nested === 'object') {
        stack.push(nested);
      }
    }
  }

  return {
    type: 'object',
    topLevelKeys: keys,
    moduleNames: Array.from(moduleNames).slice(0, 50),
  };
}

async function readPersistedStorageState(
  marketplace: string
): Promise<ResearchStorageState | undefined> {
  const resolution = createFreshEbayResearchSessionStoreResolution(marketplace);
  if (!resolution.store) return undefined;
  const raw = await resolution.store.getStorageState();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { cookies?: unknown }).cookies)
  ) {
    return undefined;
  }
  return parsed as ResearchStorageState;
}

function buildResearchSearchUrl(
  query: string,
  tabName: 'ACTIVE' | 'SOLD',
  marketplace: string
): string {
  const endDate = Date.now();
  const startDate = endDate - DEFAULT_DAY_RANGE * 24 * 60 * 60 * 1000;
  const url = new URL(RESEARCH_SEARCH_ENDPOINT);
  url.searchParams.set('marketplace', marketplace);
  url.searchParams.set('keywords', query);
  url.searchParams.set('dayRange', String(DEFAULT_DAY_RANGE));
  url.searchParams.set('endDate', String(endDate));
  url.searchParams.set('startDate', String(startDate));
  url.searchParams.set('categoryId', '0');
  url.searchParams.set('offset', '0');
  url.searchParams.set('limit', String(DEFAULT_LIMIT));
  url.searchParams.set('tabName', tabName);
  url.searchParams.set('tz', DEFAULT_TIMEZONE);
  url.searchParams.append('modules', 'aggregates');
  url.searchParams.append('modules', 'searchResults');
  url.searchParams.append('modules', 'resultsHeader');
  return url.toString();
}

async function main(): Promise<void> {
  const query = getQuery();
  const marketplace = (getArgValue('marketplace') || DEFAULT_MARKETPLACE).toUpperCase();
  const holdMs = getPositiveIntegerEnv('RESEARCH_CAPTURE_HOLD_MS', 45_000);
  const headless = /^(1|true|yes)$/i.test(process.env.RESEARCH_CAPTURE_HEADLESS ?? '');
  const outputDir = resolve(
    getArgValue('out-dir') ||
      process.env.RESEARCH_CAPTURE_OUTPUT_DIR ||
      'backups/research-network-capture'
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = resolve(outputDir, `research-network-${timestamp}.json`);

  const captured: CapturedResponse[] = [];
  const pendingCaptures: Promise<void>[] = [];
  const storageState = await readPersistedStorageState(marketplace).catch((error: unknown) => {
    console.warn(
      `[ResearchCapture] Could not load persisted storage state: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  });

  console.log(
    `[ResearchCapture] Starting ${headless ? 'headless' : 'headed+DevTools'} browser capture query="${query}" marketplace=${marketplace} storageState=${storageState ? 'loaded' : 'missing'}`
  );

  const browser = await chromium.launch({
    headless,
    devtools: !headless,
    channel: getChromiumChannel(),
    args: headless ? [] : ['--auto-open-devtools-for-tabs'],
  } as Parameters<typeof chromium.launch>[0] & { devtools?: boolean });

  const contextOptions: BrowserContextOptions = {
    viewport: { width: 1440, height: 1000 },
  };
  if (storageState) {
    contextOptions.storageState = storageState as unknown as BrowserContextOptions['storageState'];
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.on('response', (response) => {
    if (!isInterestingResponse(response)) return;
    const capturePromise = (async (): Promise<void> => {
      const request = response.request();
      const headers = response.headers();
      const contentType = headers['content-type'] ?? null;
      let bodyExcerpt: string | null = null;
      let bodyBytes = 0;
      let jsonSummary: unknown = null;
      let error: string | null = null;

      try {
        const text = await response.text();
        bodyBytes = Buffer.byteLength(text, 'utf8');
        bodyExcerpt = text.slice(0, 12_000);
        if (
          /json/i.test(contentType ?? '') ||
          text.trimStart().startsWith('{') ||
          text.trimStart().startsWith('[')
        ) {
          try {
            jsonSummary = summarizeJson(JSON.parse(text) as unknown);
          } catch (jsonError) {
            jsonSummary = {
              parseError: jsonError instanceof Error ? jsonError.message : String(jsonError),
            };
          }
        }
      } catch (bodyError) {
        error = bodyError instanceof Error ? bodyError.message : String(bodyError);
      }

      const sanitizedUrl = sanitizeUrl(response.url());
      captured.push({
        capturedAt: new Date().toISOString(),
        // Do not persist raw URLs: redirect URLs can contain session/auth parameters.
        url: sanitizedUrl,
        sanitizedUrl,
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        ok: response.ok(),
        contentType,
        requestHeaders: sanitizeHeaders(await request.allHeaders()),
        responseHeaders: sanitizeHeaders(headers),
        bodyBytes,
        bodyExcerpt,
        jsonSummary,
        error,
      });
    })();
    pendingCaptures.push(capturePromise);
  });

  try {
    const uiUrl = `${RESEARCH_UI_URL}?marketplace=${encodeURIComponent(marketplace)}&keywords=${encodeURIComponent(query)}`;
    console.log(`[ResearchCapture] Opening UI: ${uiUrl}`);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(5_000);

    const activeUrl = buildResearchSearchUrl(query, 'ACTIVE', marketplace);
    const soldUrl = buildResearchSearchUrl(query, 'SOLD', marketplace);
    console.log(
      '[ResearchCapture] Triggering browser fetches for ACTIVE and SOLD search endpoints.'
    );
    await page.evaluate(
      async (urls) => {
        for (const url of urls) {
          try {
            await fetch(url, {
              credentials: 'include',
              headers: {
                accept: 'application/json, text/plain, */*',
                'x-requested-with': 'XMLHttpRequest',
              },
            }).then((response) => response.text());
          } catch {
            // Network details are captured by Playwright response/request events.
          }
        }
      },
      [activeUrl, soldUrl]
    );

    console.log(
      `[ResearchCapture] Holding browser open for ${holdMs}ms for manual inspection/network activity...`
    );
    await page.waitForTimeout(holdMs);
  } finally {
    await Promise.allSettled(pendingCaptures);
    await mkdir(outputDir, { recursive: true });
    const report = {
      ok: true,
      capturedAt: new Date().toISOString(),
      query,
      marketplace,
      headless,
      storageStateLoaded: Boolean(storageState),
      responseCount: captured.length,
      outputPath,
      responses: captured.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
    };
    await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[ResearchCapture] Wrote sanitized network capture: ${outputPath}`);
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(
    '[ResearchCapture] Failed:',
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exit(1);
});
