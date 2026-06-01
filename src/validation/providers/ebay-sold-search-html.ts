import type { SoldItemSample } from '../types.js';

export interface EbaySoldSearchParseOptions {
  requestTimestamp: string;
  currencyRatesToUsd?: Record<string, number>;
}

interface ParsedCurrencyAmount {
  currency: string;
  amount: number;
}

export interface ParsedEbaySoldSearchHtml {
  items: SoldItemSample[];
  rawResultsCount: number | null;
  cutoffDetected: boolean;
  blockedReason: 'ebay_pardon_interruption' | 'access_denied' | null;
  parseNotes: string[];
}

const EBAY_SOLD_SEARCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function encodeSearchQuery(query: string): string {
  return encodeURIComponent(query.trim()).replace(/%20/g, '+');
}

export function buildEbaySoldSearchUrl(query: string): string {
  const encodedQuery = encodeSearchQuery(query);
  return `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}&_from=R40&_oac=1&LH_Complete=1&rt=nc&LH_Sold=1&_fcid=1&LH_PrefLoc=2`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    );
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function stripQueryAndHash(url: string): string {
  try {
    const parsed = new URL(decodeHtmlEntities(url));
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return decodeHtmlEntities(url).trim();
  }
}

function firstCapture(source: string, pattern: RegExp): string | null {
  const match = pattern.exec(source);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : null;
}

function roundMoney(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function parsePriceAmount(value: string | null): ParsedCurrencyAmount | null {
  if (!value) {
    return null;
  }

  const normalized = decodeHtmlEntities(value).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  const currencyPatterns: [string, RegExp][] = [
    ['KRW', /(?:KRW|₩)/i],
    ['JPY', /(?:JPY|(?<![A-Z])¥)/i],
    ['GBP', /(?:GBP|£)/i],
    ['EUR', /(?:EUR|€)/i],
    ['CAD', /(?:CAD|\bC\s*\$)/i],
    ['AUD', /(?:AUD|\bAU\s*\$)/i],
    ['HKD', /(?:HKD|\bHK\s*\$)/i],
    ['TWD', /(?:TWD|\bNT\s*\$)/i],
    ['CNY', /(?:CNY|RMB|\bCN\s*¥)/i],
    ['USD', /(?:USD|\bUS\s*\$|\$)/i],
  ];
  const currency = currencyPatterns.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'USD';
  const amountMatch = /([0-9]+(?:\s[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/.exec(
    normalized
  );
  if (!amountMatch?.[1]) {
    return null;
  }

  const amount = Number(amountMatch[1].replace(/\s/g, ''));
  return Number.isFinite(amount) ? { currency, amount } : null;
}

function normalizePrice(
  value: string | null,
  currencyRatesToUsd: Record<string, number> = {}
): number | null {
  const parsed = parsePriceAmount(value);
  if (!parsed) {
    return null;
  }

  if (parsed.currency === 'USD') {
    return roundMoney(parsed.amount);
  }

  const rate = currencyRatesToUsd[parsed.currency];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    ? roundMoney(parsed.amount * rate)
    : null;
}

function parseRawResultsCount(html: string): number | null {
  const text = normalizeText(html);
  const match = /([0-9][0-9,]*)\s+results?\b/i.exec(text);
  if (!match?.[1]) {
    return null;
  }

  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function inferSoldDateYear(monthIndex: number, day: number, requestDate: Date): number {
  const requestYear = Number.isFinite(requestDate.getTime())
    ? requestDate.getUTCFullYear()
    : new Date().getUTCFullYear();
  const candidate = Date.UTC(requestYear, monthIndex, day);
  const requestTime = Number.isFinite(requestDate.getTime()) ? requestDate.getTime() : Date.now();
  // Search results without a year should not be future-dated by more than a week.
  if (candidate - requestTime > 7 * 24 * 60 * 60 * 1000) {
    return requestYear - 1;
  }
  return requestYear;
}

function parseSoldDate(rowText: string, requestTimestamp: string): string | null {
  const requestDate = new Date(requestTimestamp);
  const match = /\bSold\s+(?:on\s+)?([A-Z][a-z]{2,8})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(
    rowText
  );
  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  const monthLookup: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  const monthIndex = monthLookup[match[1].toLowerCase().replace(/\.$/, '')];
  const day = Number(match[2]);
  if (monthIndex === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }

  const year = match[3] ? Number(match[3]) : inferSoldDateYear(monthIndex, day, requestDate);
  const parsed = new Date(Date.UTC(year, monthIndex, day));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function extractTitle(rowHtml: string, rowText: string): string | null {
  const titleFromClass = firstCapture(
    rowHtml,
    /<[^>]+class="[^"]*(?:s-item__title|s-card__title)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i
  );
  const title = normalizeText(titleFromClass ?? rowText)
    .replace(/^New Listing\s+/i, '')
    .replace(/\s+Opens in a new window or tab.*$/i, '')
    .trim();

  if (!title || /^Shop on eBay$/i.test(title) || /^Results matching fewer words$/i.test(title)) {
    return null;
  }

  return title;
}

function extractSoldRowsHtml(html: string): { rows: string[]; cutoffDetected: boolean } {
  const rewriteMatch = /<li\b[^>]*class="[^"]*srp-river-answer--REWRITE_START[^"]*"[\s\S]*$/i.exec(
    html
  );
  const exactRegion = rewriteMatch ? html.slice(0, rewriteMatch.index) : html;
  const rows =
    exactRegion.match(/<li\b(?=[^>]*class="[^"]*(?:s-item|s-card)[^"]*")[^>]*>[\s\S]*?<\/li>/gi) ??
    [];

  return {
    rows,
    cutoffDetected: Boolean(rewriteMatch) || /Results matching fewer words/i.test(html),
  };
}

function detectBlockedReason(html: string): ParsedEbaySoldSearchHtml['blockedReason'] {
  const visibleText = normalizeText(html);
  if (/\bPardon Our Interruption\b/i.test(visibleText) || /splashui\/captcha/i.test(html)) {
    return 'ebay_pardon_interruption';
  }
  if (/\bAccess Denied\b|\bHTTP\s*403\b|\bForbidden\b/i.test(visibleText)) {
    return 'access_denied';
  }
  return null;
}

export function parseEbaySoldSearchHtml(
  html: string,
  options: EbaySoldSearchParseOptions
): ParsedEbaySoldSearchHtml {
  const blockedReason = detectBlockedReason(html);
  if (blockedReason) {
    return {
      items: [],
      rawResultsCount: null,
      cutoffDetected: false,
      blockedReason,
      parseNotes: [`eBay sold-search HTML blocked: ${blockedReason}`],
    };
  }

  const { rows, cutoffDetected } = extractSoldRowsHtml(html);
  const items: SoldItemSample[] = [];
  const parseNotes: string[] = [];

  for (const rowHtml of rows) {
    const rowText = normalizeText(rowHtml);
    if (!/\bSold\b/i.test(rowText)) {
      continue;
    }

    const title = extractTitle(rowHtml, rowText);
    if (!title) {
      continue;
    }

    const priceText = firstCapture(
      rowHtml,
      /<[^>]+class="[^"]*(?:s-item__price|s-card__price)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i
    );
    const priceUsd = normalizePrice(priceText ?? rowText, options.currencyRatesToUsd);
    const link = firstCapture(
      rowHtml,
      /<a\b[^>]*class="[^"]*(?:s-item__link|s-card__link)[^"]*"[^>]*href="([^"]+)"/i
    );
    const soldAt = parseSoldDate(rowText, options.requestTimestamp);
    if (!soldAt) {
      parseNotes.push(`missing sold date for sold-search row: ${title}`);
    }

    items.push({
      title,
      soldAt,
      priceUsd,
      itemUrl: link ? stripQueryAndHash(link) : null,
    });
  }

  return {
    items,
    rawResultsCount: parseRawResultsCount(html),
    cutoffDetected,
    blockedReason: null,
    parseNotes,
  };
}

export function collectCurrencyCodesFromSoldSearchHtml(html: string): string[] {
  const { rows } = extractSoldRowsHtml(html);
  const currencies = new Set<string>();
  for (const rowHtml of rows) {
    const rowText = normalizeText(rowHtml);
    if (!/\bSold\b/i.test(rowText)) {
      continue;
    }
    const priceText = firstCapture(
      rowHtml,
      /<[^>]+class="[^"]*(?:s-item__price|s-card__price)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i
    );
    const parsedPrice = parsePriceAmount(priceText ?? rowText);
    if (parsedPrice && parsedPrice.currency !== 'USD') {
      currencies.add(parsedPrice.currency);
    }
  }
  return [...currencies].sort();
}

const currencyRateCache = new Map<string, number>();

function parseCurrencyRateOverrides(): Record<string, number> {
  const raw = process.env.EBAY_CURRENCY_RATES_TO_USD_JSON?.trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([currency, rate]) => [currency.toUpperCase(), Number(rate)] as const)
        .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
    );
  } catch {
    return {};
  }
}

export async function fetchCurrencyRatesToUsd(
  currencies: string[]
): Promise<Record<string, number>> {
  if (process.env.EBAY_CURRENCY_CONVERSION_ENABLED === 'false') {
    return {};
  }

  const overrides = parseCurrencyRateOverrides();
  const result: Record<string, number> = {};
  const uniqueCurrencies = [
    ...new Set(currencies.map((currency) => currency.toUpperCase())),
  ].filter((currency) => currency && currency !== 'USD');

  for (const currency of uniqueCurrencies) {
    if (overrides[currency]) {
      result[currency] = overrides[currency];
      continue;
    }
    const cachedRate = currencyRateCache.get(currency);
    if (cachedRate) {
      result[currency] = cachedRate;
      continue;
    }

    try {
      const axios = (await import('axios')).default;
      const response = await axios.get<{ result?: string; rates?: Record<string, number> }>(
        `https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`,
        { timeout: 10000, validateStatus: () => true }
      );
      const rate = response.data?.rates?.USD;
      if (
        response.status === 200 &&
        typeof rate === 'number' &&
        Number.isFinite(rate) &&
        rate > 0
      ) {
        currencyRateCache.set(currency, rate);
        result[currency] = rate;
      }
    } catch {
      // Currency conversion is best-effort. Missing rates leave non-USD prices null.
    }
  }

  return result;
}

export async function fetchEbaySoldSearchHtml(query: string): Promise<{
  html: string;
  responseUrl: string;
  status: number | null;
}> {
  const url = buildEbaySoldSearchUrl(query);
  const timeoutMs = Math.min(Number(process.env.EBAY_SOLD_SEARCH_HTML_TIMEOUT_MS ?? 60000), 120000);

  if (process.env.EBAY_SOLD_SEARCH_HTML_TRANSPORT === 'axios') {
    const axios = (await import('axios')).default;
    const response = await axios.get<string>(url, {
      timeout: timeoutMs,
      responseType: 'text',
      headers: {
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'upgrade-insecure-requests': '1',
        'user-agent': process.env.EBAY_SOLD_SEARCH_USER_AGENT ?? EBAY_SOLD_SEARCH_USER_AGENT,
        Referer: url,
      },
      validateStatus: () => true,
    });
    return {
      html: typeof response.data === 'string' ? response.data : String(response.data),
      responseUrl: url,
      status: response.status,
    };
  }

  const playwright = await import('playwright-core');
  const browser = await playwright.chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim() || undefined,
  });

  try {
    const context = await browser.newContext({
      locale: 'en-US',
      userAgent: process.env.EBAY_SOLD_SEARCH_USER_AGENT ?? EBAY_SOLD_SEARCH_USER_AGENT,
      extraHTTPHeaders: {
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
      referer: 'https://www.ebay.com/',
    });
    await page
      .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 15000) })
      .catch(() => undefined);
    const html = await page.content();
    await context.close();
    return {
      html,
      responseUrl: page.url(),
      status: response?.status() ?? null,
    };
  } finally {
    await browser.close();
  }
}
