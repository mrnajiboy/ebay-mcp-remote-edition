import axios from 'axios';
import { createKVStore, type KVStore } from '@/auth/kv-store.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ResearchStorageState {
  cookies: ResearchCookie[];
  origins: {
    origin: string;
    localStorage: {
      name: string;
      value: string;
    }[];
  }[];
}

type ResearchDebugAuthState = 'loaded' | 'authenticated' | 'missing' | 'expired' | 'unavailable';
type ResearchSessionStrategy =
  | 'env_cookies'
  | 'kv_store'
  | 'storage_state'
  | 'playwright_profile'
  | 'none';
type ResearchSessionSource = 'kv' | 'env' | 'filesystem' | 'playwright_profile' | null;

export interface EbayResearchListingRow {
  title: string;
  itemId: string | null;
  url: string | null;
  listingPriceUsd?: number | null;
  shippingUsd?: number | null;
  watchers?: number | null;
  promoted?: boolean | null;
  startDate?: string | null;
}

export interface EbayResearchSoldRow {
  title: string;
  itemId: string | null;
  url: string | null;
  avgSoldPriceUsd?: number | null;
  avgShippingUsd?: number | null;
  totalSold?: number | null;
  totalRevenueUsd?: number | null;
  lastSoldDate?: string | null;
}

export interface EbayResearchResponse {
  active: {
    avgListingPriceUsd: number | null;
    listingPriceMinUsd: number | null;
    listingPriceMaxUsd: number | null;
    avgShippingUsd: number | null;
    freeShippingPct: number | null;
    totalActiveListings: number | null;
    promotedListingsPct: number | null;
    avgWatchersPerListing: number | null;
    watcherCoverageCount: number | null;
    listingRows: EbayResearchListingRow[];
  };
  sold: {
    avgSoldPriceUsd: number | null;
    soldPriceMinUsd: number | null;
    soldPriceMaxUsd: number | null;
    avgShippingUsd: number | null;
    freeShippingPct: number | null;
    sellThroughPct: number | null;
    totalSold: number | null;
    totalSellers: number | null;
    totalItemSalesUsd: number | null;
    soldRows: EbayResearchSoldRow[];
  };
  debug: {
    query: string;
    activeEndpointUrl: string;
    soldEndpointUrl: string;
    fetchedAt: string;
    modulesSeen: string[];
    pageErrors: string[];
    activeParse?: ResearchTabParseDebug;
    soldParse?: ResearchTabParseDebug;
    usefulResponse?: boolean;
    authState: ResearchDebugAuthState;
    sessionStrategy: ResearchSessionStrategy;
    sessionSource: ResearchSessionSource;
    kvLoadAttempted: boolean;
    kvLoadSucceeded: boolean;
    kvStorageStateBytes: number | null;
    envLoadAttempted: boolean;
    envLoadSucceeded: boolean;
    filesystemLoadAttempted: boolean;
    filesystemLoadSucceeded: boolean;
    profileLoadAttempted: boolean;
    profileLoadSucceeded: boolean;
    authValidationAttempted: boolean;
    authValidationSucceeded: boolean;
    notes: string[];
  };
}

export interface FetchEbayResearchOptions {
  marketplace?: string;
  dayRange?: number;
  timezone?: string;
  startDate?: number;
  endDate?: number;
  offset?: number;
  limit?: number;
}

interface ResearchCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  secure?: boolean;
}

interface ParsedResearchModule {
  raw: unknown;
  moduleName: string;
}

interface ParsedResearchPayload {
  modules: ParsedResearchModule[];
  modulesSeen: string[];
  moduleCount: number;
  parseErrors: string[];
}

interface ResearchTabParseDebug {
  modulesSeen: string[];
  moduleCount: number;
  parseErrors: string[];
  pageErrors: string[];
  aggregateExtracted: boolean;
  rowCount: number;
  watcherCoverageCount: number;
  usefulResponse: boolean;
}

interface ResearchTabFetchResult {
  modules: ParsedResearchModule[];
  modulesSeen: string[];
  moduleCount: number;
  parseErrors: string[];
  pageErrors: string[];
  responseStatus: number;
  cacheKey: string;
  cacheEligible: boolean;
}

interface ResearchCacheEntry {
  expiresAt: number;
  value: ResearchTabFetchResult;
}

interface ResearchAuthState {
  cookies: ResearchCookie[];
  storageState: ResearchStorageState | null;
  authState: ResearchDebugAuthState;
  sessionStrategy: ResearchSessionStrategy;
  sessionSource: ResearchSessionSource;
  kvLoadAttempted: boolean;
  kvLoadSucceeded: boolean;
  kvStorageStateBytes: number | null;
  envLoadAttempted: boolean;
  envLoadSucceeded: boolean;
  filesystemLoadAttempted: boolean;
  filesystemLoadSucceeded: boolean;
  profileLoadAttempted: boolean;
  profileLoadSucceeded: boolean;
  authValidationAttempted: boolean;
  authValidationSucceeded: boolean;
  notes: string[];
}

interface PersistedResearchSession {
  cookies: ResearchCookie[];
  storageState?: ResearchStorageState | null;
  updatedAt: string;
  expiresAt: string | null;
  marketplace: string;
  source: ResearchSessionStrategy;
  sessionSource?: ResearchSessionSource;
}

interface PersistedKvStorageStateRecord {
  raw: string;
  parsed: ResearchStorageState | null;
  bytes: number;
  updatedAt: string | null;
  source: string | null;
}

interface ResearchSessionValidationResult {
  ok: boolean;
  responseStatus: number | null;
  modulesSeen: string[];
  note: string;
}

function isExplicitResearchAuthRejection(validation: ResearchSessionValidationResult): boolean {
  return validation.responseStatus === 401 || validation.responseStatus === 403;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAY_RANGE = 90;
const DEFAULT_MARKETPLACE = 'EBAY-US';
const DEFAULT_TIMEZONE = process.env.EBAY_RESEARCH_TIMEZONE?.trim() ?? 'Asia/Seoul';
const DEFAULT_LIMIT = 50;
const ACTIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SOLD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RESEARCH_ENDPOINT = 'https://www.ebay.com/sh/research/api/search';
const RESEARCH_STORAGE_STATE_PATH =
  process.env.EBAY_RESEARCH_STORAGE_STATE_PATH?.trim() ?? '.ebay-research/storage-state.json';
const RESEARCH_PROFILE_DIR =
  process.env.EBAY_RESEARCH_PROFILE_DIR?.trim() ?? '.ebay-research/profile';
const RESEARCH_COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESEARCH_AUTH_VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000;
const RESEARCH_SESSION_KEY_PREFIX = 'ebay-research:session';
const RESEARCH_SESSION_FALLBACK_TTL_S = 30 * 24 * 60 * 60;
const RESEARCH_STORAGE_STATE_ENV_KEY = 'EBAY_RESEARCH_STORAGE_STATE_JSON';
const RESEARCH_STORAGE_STATE_KV_KEY = 'ebay_research_storage_state_json';
const RESEARCH_STORAGE_STATE_UPDATED_AT_KV_KEY = 'ebay_research_storage_state_updated_at';
const RESEARCH_STORAGE_STATE_SOURCE_KV_KEY = 'ebay_research_storage_state_source';
const EBAY_HOSTNAME_PATTERN = /(^|\.)ebay\.[a-z.]+$/i;

type ResearchAuthCache = Record<
  string,
  {
    expiresAt: number;
    value: ResearchAuthState;
  }
>;

type ResearchAuthValidationCache = Record<
  string,
  {
    expiresAt: number;
    value: ResearchSessionValidationResult;
  }
>;

const researchResponseCache = new Map<string, ResearchCacheEntry>();
let researchAuthCache: ResearchAuthCache = {};
let researchAuthValidationCache: ResearchAuthValidationCache = {};
let researchSessionStoreSingleton: KVStore | null | undefined;

export class EbayResearchAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbayResearchAuthError';
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compactComparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function getResearchSessionStore(): KVStore | null {
  if (researchSessionStoreSingleton !== undefined) {
    return researchSessionStoreSingleton;
  }

  try {
    researchSessionStoreSingleton = createKVStore();
  } catch {
    researchSessionStoreSingleton = null;
  }

  return researchSessionStoreSingleton;
}

function getResearchSessionKey(marketplace: string): string {
  const environment = (process.env.EBAY_ENVIRONMENT ?? 'production').trim() || 'production';
  return `${RESEARCH_SESSION_KEY_PREFIX}:${environment}:${marketplace}`;
}

function getResearchStorageStateScopedKey(baseKey: string, marketplace: string): string {
  const environment = (process.env.EBAY_ENVIRONMENT ?? 'production').trim() || 'production';
  if (environment === 'production' && marketplace === DEFAULT_MARKETPLACE) {
    return baseKey;
  }

  return `${baseKey}:${environment}:${marketplace}`;
}

function getResearchStorageStateKvKey(marketplace: string): string {
  return getResearchStorageStateScopedKey(RESEARCH_STORAGE_STATE_KV_KEY, marketplace);
}

function getResearchStorageStateUpdatedAtKvKey(marketplace: string): string {
  return getResearchStorageStateScopedKey(RESEARCH_STORAGE_STATE_UPDATED_AT_KV_KEY, marketplace);
}

function getResearchStorageStateSourceKvKey(marketplace: string): string {
  return getResearchStorageStateScopedKey(RESEARCH_STORAGE_STATE_SOURCE_KV_KEY, marketplace);
}

function getResearchAuthFingerprint(authState: ResearchAuthState): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        authState: authState.authState,
        sessionStrategy: authState.sessionStrategy,
        sessionSource: authState.sessionSource,
        cookieHeader: buildCookieHeader(authState.cookies),
      })
    )
    .digest('hex');
}

function normalizeResearchCookie(entry: Record<string, unknown>): ResearchCookie {
  return {
    name: typeof entry.name === 'string' ? entry.name : '',
    value: typeof entry.value === 'string' ? entry.value : '',
    domain: typeof entry.domain === 'string' ? entry.domain : undefined,
    path: typeof entry.path === 'string' ? entry.path : undefined,
    expires: typeof entry.expires === 'number' ? entry.expires : undefined,
    secure: typeof entry.secure === 'boolean' ? entry.secure : undefined,
  };
}

function normalizeResearchCookies(value: unknown): ResearchCookie[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => normalizeResearchCookie(entry))
    .filter((entry) => entry.name.length > 0 && entry.value.length > 0);
}

function normalizeStorageState(value: unknown): ResearchStorageState | null {
  if (!isRecord(value) || !Array.isArray(value.cookies)) {
    return null;
  }

  const origins = Array.isArray(value.origins)
    ? value.origins
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          origin: typeof entry.origin === 'string' ? entry.origin : '',
          localStorage: Array.isArray(entry.localStorage)
            ? entry.localStorage
                .filter((storage): storage is Record<string, unknown> => isRecord(storage))
                .map((storage) => ({
                  name: typeof storage.name === 'string' ? storage.name : '',
                  value: typeof storage.value === 'string' ? storage.value : '',
                }))
                .filter((storage) => storage.name.length > 0)
            : [],
        }))
        .filter((entry) => entry.origin.length > 0)
    : [];

  return {
    cookies: normalizeResearchCookies(value.cookies),
    origins,
  } satisfies ResearchStorageState;
}

function storageStateFromCookies(cookies: ResearchCookie[]): ResearchStorageState {
  return {
    cookies,
    origins: [],
  } satisfies ResearchStorageState;
}

function getPlaywrightChromiumChannel(): string | undefined {
  const configuredChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
  return configuredChannel && configuredChannel.length > 0 ? configuredChannel : undefined;
}

function normalizeResearchHostname(value: string): string | null {
  const normalized = value.trim().replace(/^\.+/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isEbayResearchHostname(value: string): boolean {
  const normalized = normalizeResearchHostname(value);
  return normalized !== null && EBAY_HOSTNAME_PATTERN.test(normalized);
}

function getResearchOriginHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function sanitizeResearchStorageState(
  storageState: ResearchStorageState,
  sourceLabel?: string,
  notes?: string[]
): ResearchStorageState {
  const cookies = normalizeResearchCookies(storageState.cookies).filter(
    (cookie) => typeof cookie.domain === 'string' && isEbayResearchHostname(cookie.domain)
  );
  const origins = storageState.origins.filter((entry) => {
    const hostname = getResearchOriginHostname(entry.origin);
    return hostname !== null && isEbayResearchHostname(hostname);
  });

  const removedCookieCount = normalizeResearchCookies(storageState.cookies).length - cookies.length;
  const removedOriginCount = storageState.origins.length - origins.length;
  if (notes && sourceLabel && (removedCookieCount > 0 || removedOriginCount > 0)) {
    notes.push(
      `Sanitized ${sourceLabel} before use/persistence by removing ${removedCookieCount} non-eBay cookies and ${removedOriginCount} non-eBay origins.`
    );
  }

  return {
    cookies,
    origins,
  } satisfies ResearchStorageState;
}

function buildResearchAuthDebug(
  authState: ResearchAuthState
): Omit<
  EbayResearchResponse['debug'],
  | 'query'
  | 'activeEndpointUrl'
  | 'soldEndpointUrl'
  | 'fetchedAt'
  | 'modulesSeen'
  | 'pageErrors'
  | 'notes'
> {
  return {
    authState: authState.authState,
    sessionStrategy: authState.sessionStrategy,
    sessionSource: authState.sessionSource,
    kvLoadAttempted: authState.kvLoadAttempted,
    kvLoadSucceeded: authState.kvLoadSucceeded,
    kvStorageStateBytes: authState.kvStorageStateBytes,
    envLoadAttempted: authState.envLoadAttempted,
    envLoadSucceeded: authState.envLoadSucceeded,
    filesystemLoadAttempted: authState.filesystemLoadAttempted,
    filesystemLoadSucceeded: authState.filesystemLoadSucceeded,
    profileLoadAttempted: authState.profileLoadAttempted,
    profileLoadSucceeded: authState.profileLoadSucceeded,
    authValidationAttempted: authState.authValidationAttempted,
    authValidationSucceeded: authState.authValidationSucceeded,
  };
}

interface PlaywrightModule {
  chromium?: {
    launch?: (options: Record<string, unknown>) => Promise<{
      newContext: (options?: Record<string, unknown>) => Promise<{
        cookies: (urls?: string | string[]) => Promise<ResearchCookie[]>;
        storageState: () => Promise<ResearchStorageState>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
    launchPersistentContext?: (
      userDataDir: string,
      options: Record<string, unknown>
    ) => Promise<{
      cookies: (urls?: string | string[]) => Promise<ResearchCookie[]>;
      storageState: () => Promise<ResearchStorageState>;
      close: () => Promise<void>;
    }>;
  };
}

async function loadPlaywrightModule(): Promise<PlaywrightModule | null> {
  const playwrightModuleName = 'playwright-core';
  try {
    return (await import(playwrightModuleName)) as PlaywrightModule;
  } catch {
    return null;
  }
}

function getResearchTabCacheKey(
  query: string,
  tabName: 'ACTIVE' | 'SOLD',
  options: Required<FetchEbayResearchOptions>,
  authState: ResearchAuthState
): string {
  return JSON.stringify({
    query,
    tabName,
    marketplace: options.marketplace,
    dayRange: options.dayRange,
    startDate: options.startDate,
    endDate: options.endDate,
    offset: options.offset,
    limit: options.limit,
    authFingerprint: getResearchAuthFingerprint(authState),
  });
}

function setResearchResponseCache(
  cacheKey: string,
  tabName: 'ACTIVE' | 'SOLD',
  value: ResearchTabFetchResult
): void {
  researchResponseCache.set(cacheKey, {
    expiresAt: Date.now() + (tabName === 'ACTIVE' ? ACTIVE_CACHE_TTL_MS : SOLD_CACHE_TTL_MS),
    value,
  });
}

function getCookieExpiryMs(cookies: ResearchCookie[]): number | null {
  const nowSeconds = Date.now() / 1000;
  const expiriesMs = cookies
    .map((cookie) => cookie.expires ?? null)
    .filter((expires): expires is number => typeof expires === 'number' && expires > nowSeconds)
    .map((expires) => expires * 1000);

  return expiriesMs.length > 0 ? Math.min(...expiriesMs) : null;
}

function getResearchAuthValidationCacheKey(marketplace: string, cookies: ResearchCookie[]): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        marketplace,
        cookieHeader: buildCookieHeader(cookies),
      })
    )
    .digest('hex');
}

async function readResearchSessionFromKv(
  marketplace: string
): Promise<PersistedResearchSession | null> {
  const store = getResearchSessionStore();
  if (!store) {
    return null;
  }

  return await store.get<PersistedResearchSession>(getResearchSessionKey(marketplace));
}

async function readResearchStorageStateFromKv(
  marketplace: string
): Promise<PersistedKvStorageStateRecord | null> {
  const store = getResearchSessionStore();
  if (!store) {
    return null;
  }

  const [rawValue, updatedAt, source] = await Promise.all([
    store.get<string>(getResearchStorageStateKvKey(marketplace)),
    store.get<string>(getResearchStorageStateUpdatedAtKvKey(marketplace)),
    store.get<string>(getResearchStorageStateSourceKvKey(marketplace)),
  ]);
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return null;
  }

  let parsed: ResearchStorageState | null;
  try {
    parsed = normalizeStorageState(JSON.parse(rawValue) as unknown);
  } catch {
    parsed = null;
  }

  return {
    raw: rawValue,
    parsed,
    bytes: Buffer.byteLength(rawValue, 'utf8'),
    updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    source: typeof source === 'string' ? source : null,
  };
}

async function persistResearchSessionToKv(options: {
  marketplace: string;
  cookies: ResearchCookie[];
  storageState?: ResearchStorageState | null;
  source: ResearchSessionStrategy;
  sessionSource?: ResearchSessionSource;
}): Promise<void> {
  const store = getResearchSessionStore();
  const persistedStorageState = options.storageState
    ? sanitizeResearchStorageState(options.storageState)
    : null;
  const persistedCookies = persistedStorageState
    ? normalizeResearchCookies(persistedStorageState.cookies)
    : normalizeResearchCookies(options.cookies);

  if (!store || persistedCookies.length === 0) {
    return;
  }

  const expiryMs = getCookieExpiryMs(persistedCookies);
  const ttlSeconds = expiryMs
    ? Math.max(
        60,
        Math.min(RESEARCH_SESSION_FALLBACK_TTL_S, Math.floor((expiryMs - Date.now()) / 1000))
      )
    : RESEARCH_SESSION_FALLBACK_TTL_S;
  const updatedAt = new Date().toISOString();
  const serializedStorageState = JSON.stringify(
    persistedStorageState ?? storageStateFromCookies(persistedCookies)
  );

  await Promise.all([
    store.put(
      getResearchStorageStateKvKey(options.marketplace),
      serializedStorageState,
      ttlSeconds
    ),
    store.put(getResearchStorageStateUpdatedAtKvKey(options.marketplace), updatedAt, ttlSeconds),
    store.put(
      getResearchStorageStateSourceKvKey(options.marketplace),
      options.sessionSource ?? options.source ?? 'kv',
      ttlSeconds
    ),
    store.put(
      getResearchSessionKey(options.marketplace),
      {
        cookies: persistedCookies,
        storageState: persistedStorageState ?? storageStateFromCookies(persistedCookies),
        updatedAt,
        expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
        marketplace: options.marketplace,
        source: options.source,
        sessionSource: options.sessionSource ?? 'kv',
      } satisfies PersistedResearchSession,
      ttlSeconds
    ),
  ]);
}

async function deleteResearchSessionFromKv(marketplace: string): Promise<void> {
  const store = getResearchSessionStore();
  if (!store) {
    return;
  }

  try {
    await Promise.all([
      store.delete(getResearchStorageStateKvKey(marketplace)),
      store.delete(getResearchStorageStateUpdatedAtKvKey(marketplace)),
      store.delete(getResearchStorageStateSourceKvKey(marketplace)),
      store.delete(getResearchSessionKey(marketplace)),
    ]);
  } catch {
    // Ignore KV invalidation failures so auth diagnostics can still surface.
  }
}

async function deleteCanonicalResearchStorageStateFromKv(marketplace: string): Promise<void> {
  const store = getResearchSessionStore();
  if (!store) {
    return;
  }

  try {
    await Promise.all([
      store.delete(getResearchStorageStateKvKey(marketplace)),
      store.delete(getResearchStorageStateUpdatedAtKvKey(marketplace)),
      store.delete(getResearchStorageStateSourceKvKey(marketplace)),
    ]);
  } catch {
    // Ignore KV invalidation failures so auth diagnostics can still surface.
  }
}

function invalidateResearchAuthValidationCache(
  marketplace: string,
  cookies: ResearchCookie[]
): void {
  delete researchAuthValidationCache[getResearchAuthValidationCacheKey(marketplace, cookies)];
}

async function validateResearchAuthState(options: {
  marketplace: string;
  cookies: ResearchCookie[];
  sourceLabel: string;
}): Promise<ResearchSessionValidationResult> {
  const cacheKey = getResearchAuthValidationCacheKey(options.marketplace, options.cookies);
  const cached = researchAuthValidationCache[cacheKey];
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      note: `${cached.value.note} (validation cache reused).`,
    };
  }

  const validationUrl = buildResearchUrl('pokemon', 'ACTIVE', {
    marketplace: options.marketplace,
    dayRange: 30,
    timezone: DEFAULT_TIMEZONE,
    startDate: Date.now() - 30 * DAY_MS,
    endDate: Date.now(),
    offset: 0,
    limit: 1,
  });
  const cookieHeader = buildCookieHeader(options.cookies);
  if (!cookieHeader) {
    return {
      ok: false,
      responseStatus: null,
      modulesSeen: [],
      note: `${options.sourceLabel} did not provide any usable cookies for validation.`,
    };
  }

  try {
    const response = await axios.get<string>(validationUrl, {
      responseType: 'text',
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: cookieHeader,
        'x-requested-with': 'XMLHttpRequest',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });
    const parsedPayload = parseResearchModules(response.data);
    const modulesSeen = parsedPayload.modulesSeen;
    const ok = response.status >= 200 && response.status < 300 && modulesSeen.length > 0;
    const result: ResearchSessionValidationResult = ok
      ? {
          ok: true,
          responseStatus: response.status,
          modulesSeen,
          note: `${options.sourceLabel} passed ACTIVE endpoint validation with ${modulesSeen.length} research modules.`,
        }
      : {
          ok: false,
          responseStatus: response.status,
          modulesSeen,
          note:
            response.status === 401 || response.status === 403
              ? `${options.sourceLabel} was rejected by the ACTIVE endpoint with status ${response.status}.`
              : `${options.sourceLabel} reached the ACTIVE endpoint but did not return usable research modules.`,
        };

    researchAuthValidationCache[cacheKey] = {
      expiresAt: Date.now() + RESEARCH_AUTH_VALIDATION_CACHE_TTL_MS,
      value: result,
    };
    return result;
  } catch (error) {
    const result: ResearchSessionValidationResult = {
      ok: false,
      responseStatus: null,
      modulesSeen: [],
      note: `${options.sourceLabel} validation failed before research modules could be confirmed (${error instanceof Error ? error.message : String(error)}).`,
    };
    researchAuthValidationCache[cacheKey] = {
      expiresAt: Date.now() + RESEARCH_AUTH_VALIDATION_CACHE_TTL_MS,
      value: result,
    };
    return result;
  }
}

function toAbsolutePath(pathValue: string): string {
  return pathValue.startsWith('/') ? pathValue : resolve(process.cwd(), pathValue);
}

function extractDisplayText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractDisplayText(entry))
      .filter((entry) => entry.length > 0)
      .join(' ')
      .trim();
  }

  if (!isRecord(value)) {
    return '';
  }

  const textSpans = value.textSpans;
  if (Array.isArray(textSpans)) {
    return textSpans
      .map((entry) =>
        isRecord(entry) ? extractDisplayText(entry.text) || extractDisplayText(entry) : ''
      )
      .filter((entry) => entry.length > 0)
      .join('')
      .trim();
  }

  for (const key of [
    'text',
    'label',
    'title',
    'value',
    'formattedValue',
    'displayValue',
    'subtitle',
  ]) {
    const nested = extractDisplayText(value[key]);
    if (nested.length > 0) {
      return nested;
    }
  }

  return '';
}

function collectDisplayTexts(value: unknown, bucket: string[] = [], limit = 80): string[] {
  if (bucket.length >= limit) {
    return bucket;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      bucket.push(trimmed);
    }
    return bucket;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    bucket.push(String(value));
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDisplayTexts(entry, bucket, limit);
      if (bucket.length >= limit) {
        break;
      }
    }
    return bucket;
  }

  if (!isRecord(value)) {
    return bucket;
  }

  const text = extractDisplayText(value);
  if (text.length > 0) {
    bucket.push(text);
  }

  for (const nestedValue of Object.values(value)) {
    collectDisplayTexts(nestedValue, bucket, limit);
    if (bucket.length >= limit) {
      break;
    }
  }

  return bucket;
}

function getObjectPath(source: unknown, path: string[]): unknown {
  let current: unknown = source;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function parseNumberLike(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/,/g, '').replace(/\s+/g, ' ').trim();
  if (/^free shipping$/i.test(normalized)) {
    return 0;
  }

  const numberPattern = /-?\d+(?:\.\d+)?/u;
  const match = numberPattern.exec(normalized);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? round(parsed) : null;
}

function parseCurrencyValue(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  if (/free shipping/i.test(value)) {
    return 0;
  }

  return parseNumberLike(value.replace(/\$/g, '').replace(/\+/g, ''));
}

function parsePercentValue(value: string | null | undefined): number | null {
  return parseNumberLike(value?.replace(/%/g, '') ?? null);
}

function parseRange(value: string | null | undefined): {
  min: number | null;
  max: number | null;
} {
  if (!value) {
    return { min: null, max: null };
  }

  const matches = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g) ?? [];
  const numbers = matches
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .map((entry) => round(entry));

  return {
    min: numbers[0] ?? null,
    max: numbers[1] ?? numbers[0] ?? null,
  };
}

function getModuleName(value: unknown): string {
  if (!isRecord(value)) {
    return 'UnknownModule';
  }

  const metaName = isRecord(value.meta) ? extractDisplayText(value.meta.name) : '';
  const typeName = typeof value._type === 'string' ? value._type : '';
  const explicitName = typeof value.name === 'string' ? value.name : '';
  return typeName || metaName || explicitName || 'UnknownModule';
}

function matchesLabel(value: string, labels: string[]): boolean {
  const comparable = normalizeComparableText(value);
  const compact = compactComparableText(value);

  return labels.some((label) => {
    const normalizedLabel = normalizeComparableText(label);
    const compactLabel = compactComparableText(label);
    return (
      comparable === normalizedLabel ||
      comparable.includes(normalizedLabel) ||
      normalizedLabel.includes(comparable) ||
      compact === compactLabel ||
      compact.includes(compactLabel) ||
      compactLabel.includes(compact)
    );
  });
}

function collectValueCandidates(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((entry) => collectValueCandidates(entry)));
  }

  if (!isRecord(value)) {
    return [];
  }

  const preferredKeys = [
    'value',
    'formattedValue',
    'displayValue',
    'summary',
    'metricValue',
    'range',
    'amount',
    'text',
    'subtitle',
  ];
  const preferredValues = preferredKeys.flatMap((key) => collectValueCandidates(value[key]));
  if (preferredValues.length > 0) {
    return uniqueStrings(preferredValues);
  }

  const text = extractDisplayText(value);
  return text ? [text] : [];
}

function findMetricText(root: unknown, labels: string[]): string | null {
  const matches: string[] = [];

  function walk(node: unknown): void {
    if (matches.length > 0) {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
        if (matches.length > 0) {
          return;
        }
      }
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    const entries = Object.entries(node);
    let labelFound = false;

    for (const [key, value] of entries) {
      if (matchesLabel(key, labels)) {
        labelFound = true;
        break;
      }

      const text = extractDisplayText(value);
      if (text.length > 0 && matchesLabel(text, labels)) {
        labelFound = true;
        break;
      }
    }

    if (labelFound) {
      const candidates = uniqueStrings(
        entries.flatMap(([key, value]) => {
          if (matchesLabel(key, labels)) {
            return [];
          }

          const values = collectValueCandidates(value);
          return values.filter((entry) => !matchesLabel(entry, labels));
        })
      );

      const selected = candidates.find((entry) => entry.length > 0);
      if (selected) {
        matches.push(selected);
        return;
      }
    }

    for (const nestedValue of Object.values(node)) {
      walk(nestedValue);
      if (matches.length > 0) {
        return;
      }
    }
  }

  walk(root);
  return matches[0] ?? null;
}

function collectAggregateMetricMap(module: unknown): Record<string, string> {
  const metrics: Record<string, string> = {};

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    const headerText = extractDisplayText(node.header);
    const valueText = extractDisplayText(node.value);
    if (headerText.length > 0 && valueText.length > 0) {
      metrics[compactComparableText(headerText)] = valueText;
    }

    for (const nestedValue of Object.values(node)) {
      walk(nestedValue);
    }
  }

  walk(module);
  return metrics;
}

function findAggregateMetricText(module: unknown, labels: string[]): string | null {
  const metricMap = collectAggregateMetricMap(module);

  for (const label of labels) {
    const direct = metricMap[compactComparableText(label)];
    if (direct) {
      return direct;
    }
  }

  return findMetricText(module, labels);
}

function findResultEntries(root: unknown): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    const listing = node.listing;
    if (isRecord(listing)) {
      const title = extractDisplayText(getObjectPath(listing, ['title']));
      const itemId = extractDisplayText(getObjectPath(listing, ['itemId', 'value']));
      if (title.length > 0 || itemId.length > 0) {
        const dedupeKey = `${itemId}:${title}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          results.push(node);
        }
      }
    }

    for (const nestedValue of Object.values(node)) {
      walk(nestedValue);
    }
  }

  walk(root);
  return results;
}

function parsePromotedValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (!value) {
    return null;
  }

  const text = extractDisplayText(value);
  if (text.length > 0) {
    if (/^(?:-|—|–)$/u.test(text)) {
      return false;
    }
    if (/^(?:yes|true|promoted)$/i.test(text)) {
      return true;
    }
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).map((entry) => entry.toLowerCase());
    if (keys.some((entry) => /(icon|badge|tooltip|indicator|promoted)/.test(entry))) {
      return true;
    }
    return Object.keys(value).length === 0 ? false : null;
  }

  return null;
}

function parseActiveRows(module: unknown): EbayResearchListingRow[] {
  return findResultEntries(module).map((result) => {
    const title =
      extractDisplayText(getObjectPath(result, ['listing', 'title'])) || 'Untitled active listing';
    const itemId =
      extractDisplayText(getObjectPath(result, ['listing', 'itemId', 'value'])) || null;
    const url =
      extractDisplayText(getObjectPath(result, ['listing', 'title', 'action', 'URL'])) || null;
    const listingPriceText = extractDisplayText(
      getObjectPath(result, ['listingPrice', 'listingPrice'])
    );
    const shippingText = extractDisplayText(
      getObjectPath(result, ['listingPrice', 'listingShipping'])
    );
    const watchersText = extractDisplayText(getObjectPath(result, ['watchers']));

    return {
      title,
      itemId,
      url,
      listingPriceUsd: parseCurrencyValue(listingPriceText),
      shippingUsd: parseCurrencyValue(shippingText),
      watchers: parseNumberLike(watchersText),
      promoted:
        parsePromotedValue(result.promoted) ??
        parsePromotedValue(result.promotedListing) ??
        parsePromotedValue(result.promotedIndicator),
      startDate: extractDisplayText(getObjectPath(result, ['startDate'])) || null,
    };
  });
}

function parseSoldRows(module: unknown): EbayResearchSoldRow[] {
  return findResultEntries(module).map((result) => ({
    title:
      extractDisplayText(getObjectPath(result, ['listing', 'title'])) || 'Untitled sold listing',
    itemId: extractDisplayText(getObjectPath(result, ['listing', 'itemId', 'value'])) || null,
    url: extractDisplayText(getObjectPath(result, ['listing', 'title', 'action', 'URL'])) || null,
    avgSoldPriceUsd: parseCurrencyValue(
      extractDisplayText(getObjectPath(result, ['avgsalesprice', 'avgsalesprice']))
    ),
    avgShippingUsd: parseCurrencyValue(
      extractDisplayText(getObjectPath(result, ['avgshipping', 'avgshipping']))
    ),
    totalSold: parseNumberLike(extractDisplayText(getObjectPath(result, ['itemssold']))),
    totalRevenueUsd: parseCurrencyValue(extractDisplayText(getObjectPath(result, ['totalsales']))),
    lastSoldDate: extractDisplayText(getObjectPath(result, ['datelastsold'])) || null,
  }));
}

function aggregateHasUsefulValues(value: Record<string, number | null>): boolean {
  return Object.values(value).some((entry) => entry !== null);
}

function parseActiveAggregate(
  module: unknown
): Omit<
  EbayResearchResponse['active'],
  'avgWatchersPerListing' | 'watcherCoverageCount' | 'listingRows'
> {
  const listingPriceRange = parseRange(findAggregateMetricText(module, ['Listing price range']));

  return {
    avgListingPriceUsd: parseCurrencyValue(findAggregateMetricText(module, ['Avg listing price'])),
    listingPriceMinUsd: listingPriceRange.min,
    listingPriceMaxUsd: listingPriceRange.max,
    avgShippingUsd: parseCurrencyValue(findAggregateMetricText(module, ['Avg shipping'])),
    freeShippingPct: parsePercentValue(findAggregateMetricText(module, ['Free shipping'])),
    totalActiveListings: parseNumberLike(findAggregateMetricText(module, ['Total active listings'])),
    promotedListingsPct: parsePercentValue(findAggregateMetricText(module, ['Promoted listings'])),
  };
}

function parseSoldAggregate(module: unknown): Omit<EbayResearchResponse['sold'], 'soldRows'> {
  const soldPriceRange = parseRange(findAggregateMetricText(module, ['Sold price range']));

  return {
    avgSoldPriceUsd: parseCurrencyValue(findAggregateMetricText(module, ['Avg sold price'])),
    soldPriceMinUsd: soldPriceRange.min,
    soldPriceMaxUsd: soldPriceRange.max,
    avgShippingUsd: parseCurrencyValue(findAggregateMetricText(module, ['Avg shipping'])),
    freeShippingPct: parsePercentValue(findAggregateMetricText(module, ['Free shipping'])),
    sellThroughPct: parsePercentValue(findAggregateMetricText(module, ['Sell-through'])),
    totalSold: parseNumberLike(findAggregateMetricText(module, ['Total sold'])),
    totalSellers: parseNumberLike(findAggregateMetricText(module, ['Total sellers'])),
    totalItemSalesUsd: parseCurrencyValue(findAggregateMetricText(module, ['Total item sales'])),
  };
}

function buildWatcherMetrics(rows: EbayResearchListingRow[]): {
  avgWatchersPerListing: number | null;
  watcherCoverageCount: number | null;
} {
  const watcherValues = rows
    .map((row) => row.watchers)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (watcherValues.length === 0) {
    return {
      avgWatchersPerListing: null,
      watcherCoverageCount: null,
    };
  }

  const total = watcherValues.reduce((sum, value) => sum + value, 0);
  return {
    avgWatchersPerListing: round(total / watcherValues.length),
    watcherCoverageCount: watcherValues.length,
  };
}

function findJsonObjectBoundary(value: string): number | null {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (character === '\\') {
        escaping = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{' || character === '[') {
      depth += 1;
      continue;
    }

    if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

function consumeJsonChunks(buffer: string): {
  chunks: string[];
  remainder: string;
  parseErrors: string[];
} {
  const chunks: string[] = [];
  const parseErrors: string[] = [];
  let working = buffer.trim();

  while (working.length > 0) {
    const firstJsonIndex = working.search(/[[{]/u);
    if (firstJsonIndex === -1) {
      parseErrors.push(`Skipped non-JSON payload fragment: ${working.slice(0, 120)}`);
      return { chunks, remainder: '', parseErrors };
    }

    if (firstJsonIndex > 0) {
      const skipped = working.slice(0, firstJsonIndex).trim();
      if (skipped.length > 0) {
        parseErrors.push(`Skipped non-JSON prefix: ${skipped.slice(0, 120)}`);
      }
      working = working.slice(firstJsonIndex).trim();
      continue;
    }

    const boundary = findJsonObjectBoundary(working);
    if (boundary === null) {
      return {
        chunks,
        remainder: working,
        parseErrors,
      };
    }

    chunks.push(working.slice(0, boundary));
    working = working.slice(boundary).trim();
  }

  return {
    chunks,
    remainder: '',
    parseErrors,
  };
}

function parseResearchModules(payload: string): ParsedResearchPayload {
  const modules: ParsedResearchModule[] = [];
  const parseErrors: string[] = [];
  let buffer = '';

  for (const rawLine of payload.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    buffer += line;
    const extracted = consumeJsonChunks(buffer);
    parseErrors.push(...extracted.parseErrors);
    buffer = extracted.remainder;

    for (const chunk of extracted.chunks) {
      try {
        const parsed = JSON.parse(chunk) as unknown;
        modules.push({
          raw: parsed,
          moduleName: getModuleName(parsed),
        });
      } catch (error) {
        parseErrors.push(
          `Failed to parse research module chunk: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (buffer.trim().length > 0) {
    const extracted = consumeJsonChunks(buffer);
    parseErrors.push(...extracted.parseErrors);

    for (const chunk of extracted.chunks) {
      try {
        const parsed = JSON.parse(chunk) as unknown;
        modules.push({
          raw: parsed,
          moduleName: getModuleName(parsed),
        });
      } catch (error) {
        parseErrors.push(
          `Failed to parse research module chunk: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (extracted.remainder.trim().length > 0) {
      parseErrors.push(
        `Incomplete JSON module fragment: ${extracted.remainder.trim().slice(0, 120)}`
      );
    }
  }

  const modulesSeen = uniqueStrings(modules.map((module) => module.moduleName));
  return {
    modules,
    modulesSeen,
    moduleCount: modules.length,
    parseErrors: uniqueStrings(parseErrors),
  };
}

function extractPageErrors(modules: ParsedResearchModule[]): string[] {
  const pageErrorModules = modules.filter((module) => /PageErrorModule/i.test(module.moduleName));
  if (pageErrorModules.length === 0) {
    return [];
  }

  const errors = pageErrorModules
    .flatMap((module) => collectDisplayTexts(module.raw, [], 20))
    .filter((entry) => !/PageErrorModule/i.test(entry));

  const uniqueErrors = uniqueStrings(errors).slice(0, 10);
  return uniqueErrors.length > 0 ? uniqueErrors : ['PageErrorModule present'];
}

function isUsefulActiveResearchPayload(
  value: Omit<
    EbayResearchResponse['active'],
    'avgWatchersPerListing' | 'watcherCoverageCount' | 'listingRows'
  >,
  rowCount: number
): boolean {
  return (
    rowCount > 0 ||
    aggregateHasUsefulValues({
      avgListingPriceUsd: value.avgListingPriceUsd,
      listingPriceMinUsd: value.listingPriceMinUsd,
      listingPriceMaxUsd: value.listingPriceMaxUsd,
      avgShippingUsd: value.avgShippingUsd,
      freeShippingPct: value.freeShippingPct,
      totalActiveListings: value.totalActiveListings,
      promotedListingsPct: value.promotedListingsPct,
    })
  );
}

function isUsefulSoldResearchPayload(
  value: Omit<EbayResearchResponse['sold'], 'soldRows'>,
  rowCount: number
): boolean {
  return (
    rowCount > 0 ||
    aggregateHasUsefulValues({
      avgSoldPriceUsd: value.avgSoldPriceUsd,
      soldPriceMinUsd: value.soldPriceMinUsd,
      soldPriceMaxUsd: value.soldPriceMaxUsd,
      avgShippingUsd: value.avgShippingUsd,
      freeShippingPct: value.freeShippingPct,
      sellThroughPct: value.sellThroughPct,
      totalSold: value.totalSold,
      totalSellers: value.totalSellers,
      totalItemSalesUsd: value.totalItemSalesUsd,
    })
  );
}

function buildResearchTabParseDebug(options: {
  fetchResult: ResearchTabFetchResult;
  aggregateExtracted: boolean;
  rowCount: number;
  watcherCoverageCount?: number | null;
  usefulResponse: boolean;
}): ResearchTabParseDebug {
  return {
    modulesSeen: options.fetchResult.modulesSeen,
    moduleCount: options.fetchResult.moduleCount,
    parseErrors: options.fetchResult.parseErrors,
    pageErrors: options.fetchResult.pageErrors,
    aggregateExtracted: options.aggregateExtracted,
    rowCount: options.rowCount,
    watcherCoverageCount: options.watcherCoverageCount ?? 0,
    usefulResponse: options.usefulResponse,
  };
}

function hasUsefulResearchPayload(value: EbayResearchResponse): boolean {
  return (
    value.active.listingRows.length > 0 ||
    value.sold.soldRows.length > 0 ||
    aggregateHasUsefulValues({
      avgListingPriceUsd: value.active.avgListingPriceUsd,
      listingPriceMinUsd: value.active.listingPriceMinUsd,
      listingPriceMaxUsd: value.active.listingPriceMaxUsd,
      avgShippingUsd: value.active.avgShippingUsd,
      freeShippingPct: value.active.freeShippingPct,
      totalActiveListings: value.active.totalActiveListings,
      promotedListingsPct: value.active.promotedListingsPct,
      avgWatchersPerListing: value.active.avgWatchersPerListing,
      watcherCoverageCount: value.active.watcherCoverageCount,
    }) ||
    aggregateHasUsefulValues({
      avgSoldPriceUsd: value.sold.avgSoldPriceUsd,
      soldPriceMinUsd: value.sold.soldPriceMinUsd,
      soldPriceMaxUsd: value.sold.soldPriceMaxUsd,
      avgShippingUsd: value.sold.avgShippingUsd,
      freeShippingPct: value.sold.freeShippingPct,
      sellThroughPct: value.sold.sellThroughPct,
      totalSold: value.sold.totalSold,
      totalSellers: value.sold.totalSellers,
      totalItemSalesUsd: value.sold.totalItemSalesUsd,
    })
  );
}

function buildResearchUrl(
  query: string,
  tabName: 'ACTIVE' | 'SOLD',
  options: Required<FetchEbayResearchOptions>
): string {
  const url = new URL(RESEARCH_ENDPOINT);
  url.searchParams.set('marketplace', options.marketplace);
  url.searchParams.set('keywords', query);
  url.searchParams.set('dayRange', String(options.dayRange));
  url.searchParams.set('endDate', String(options.endDate));
  url.searchParams.set('startDate', String(options.startDate));
  url.searchParams.set('categoryId', '0');
  url.searchParams.set('offset', String(options.offset));
  url.searchParams.set('limit', String(options.limit));
  url.searchParams.set('tabName', tabName);
  url.searchParams.set('tz', options.timezone);
  url.searchParams.append('modules', 'aggregates');
  url.searchParams.append('modules', 'searchResults');
  url.searchParams.append('modules', 'resultsHeader');
  return url.toString();
}

function buildCookieHeader(cookies: ResearchCookie[]): string {
  const nowSeconds = Date.now() / 1000;
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .filter((cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function readStorageStateFile(
  storageStatePath: string
): Promise<ResearchStorageState | null> {
  if (!existsSync(storageStatePath)) {
    return null;
  }

  return normalizeStorageState(JSON.parse(await readFile(storageStatePath, 'utf8')) as unknown);
}

async function resolveStorageStateCookies(
  storageState: ResearchStorageState,
  sourceLabel: string,
  notes: string[]
): Promise<{ cookies: ResearchCookie[]; storageState: ResearchStorageState } | null> {
  const sanitizedStorageState = sanitizeResearchStorageState(storageState, sourceLabel, notes);
  const storedCookies = normalizeResearchCookies(sanitizedStorageState.cookies);
  if (storedCookies.length === 0) {
    notes.push(`${sourceLabel} did not contain any usable eBay cookies.`);
    return null;
  }

  const playwrightModule = await loadPlaywrightModule();
  if (!playwrightModule?.chromium?.launch) {
    notes.push(
      `Playwright runtime was unavailable while hydrating ${sourceLabel}; falling back to cookies embedded in storage state.`
    );
    return { cookies: storedCookies, storageState: sanitizedStorageState };
  }

  try {
    const browser = await playwrightModule.chromium.launch({
      headless: true,
      channel: getPlaywrightChromiumChannel(),
    });

    try {
      const context = await browser.newContext({ storageState: sanitizedStorageState });
      try {
        const cookies = normalizeResearchCookies(await context.cookies('https://www.ebay.com'));
        const refreshedStorageState =
          normalizeStorageState(await context.storageState()) ?? sanitizedStorageState;
        const sanitizedRefreshedState = sanitizeResearchStorageState(
          refreshedStorageState,
          sourceLabel,
          notes
        );
        notes.push(`Hydrated ${sourceLabel} through Playwright headless Chromium.`);
        return {
          cookies: cookies.length > 0 ? cookies : storedCookies,
          storageState: sanitizedRefreshedState,
        };
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    notes.push(
      `${sourceLabel} could not be hydrated through Playwright (${error instanceof Error ? error.message : String(error)}); falling back to cookies embedded in storage state.`
    );
    return { cookies: storedCookies, storageState: sanitizedStorageState };
  }
}

async function readPlaywrightProfileState(
  profileDir: string,
  notes: string[]
): Promise<{ cookies: ResearchCookie[]; storageState: ResearchStorageState } | null> {
  if (!existsSync(profileDir)) {
    return null;
  }

  const playwrightModule = await loadPlaywrightModule();
  if (!playwrightModule?.chromium?.launchPersistentContext) {
    notes.push(
      'Playwright runtime is unavailable, so the local Playwright profile could not be loaded.'
    );
    return null;
  }

  const context = await playwrightModule.chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: getPlaywrightChromiumChannel(),
  });

  try {
    const cookies = normalizeResearchCookies(await context.cookies('https://www.ebay.com'));
    const storageState =
      normalizeStorageState(await context.storageState()) ?? storageStateFromCookies(cookies);
    return {
      cookies,
      storageState: sanitizeResearchStorageState(
        storageState,
        `Playwright profile at ${profileDir}`,
        notes
      ),
    };
  } finally {
    await context.close();
  }
}

async function resolveResearchAuthState(marketplace: string): Promise<ResearchAuthState> {
  const cachedAuthState = researchAuthCache[marketplace];
  if (cachedAuthState && cachedAuthState.expiresAt > Date.now()) {
    return cachedAuthState.value;
  }

  const notes: string[] = [];
  const envStorageStateRaw = process.env[RESEARCH_STORAGE_STATE_ENV_KEY]?.trim();
  const envCookiesRaw = process.env.EBAY_RESEARCH_COOKIES_JSON?.trim();
  const diagnostics: Pick<
    ResearchAuthState,
    | 'sessionSource'
    | 'kvLoadAttempted'
    | 'kvLoadSucceeded'
    | 'kvStorageStateBytes'
    | 'envLoadAttempted'
    | 'envLoadSucceeded'
    | 'filesystemLoadAttempted'
    | 'filesystemLoadSucceeded'
    | 'profileLoadAttempted'
    | 'profileLoadSucceeded'
    | 'authValidationAttempted'
    | 'authValidationSucceeded'
  > = {
    sessionSource: null,
    kvLoadAttempted: false,
    kvLoadSucceeded: false,
    kvStorageStateBytes: null,
    envLoadAttempted: false,
    envLoadSucceeded: false,
    filesystemLoadAttempted: false,
    filesystemLoadSucceeded: false,
    profileLoadAttempted: false,
    profileLoadSucceeded: false,
    authValidationAttempted: false,
    authValidationSucceeded: false,
  };

  diagnostics.kvLoadAttempted = true;
  const store = getResearchSessionStore();
  if (store !== null) {
    const kvStorageStateRecord = await readResearchStorageStateFromKv(marketplace);
    let shouldAttemptLegacyKvFallback = true;
    if (kvStorageStateRecord) {
      diagnostics.kvStorageStateBytes = kvStorageStateRecord.bytes;
      if (kvStorageStateRecord.parsed) {
        const resolvedSession = await resolveStorageStateCookies(
          kvStorageStateRecord.parsed,
          `${store.backendName} KV storage state`,
          notes
        );
        if (resolvedSession && resolvedSession.cookies.length > 0) {
          diagnostics.kvLoadSucceeded = true;
          diagnostics.authValidationAttempted = true;
          const validation = await validateResearchAuthState({
            marketplace,
            cookies: resolvedSession.cookies,
            sourceLabel: `${store.backendName} KV storage state`,
          });
          diagnostics.authValidationSucceeded = validation.ok;
          notes.push(validation.note);
          if (validation.ok) {
            const value: ResearchAuthState = {
              cookies: resolvedSession.cookies,
              storageState: resolvedSession.storageState,
              authState: 'loaded',
              sessionStrategy: 'storage_state',
              ...diagnostics,
              sessionSource: 'kv',
              notes: [
                ...notes,
                `Restored canonical eBay Research storage state from ${store.backendName}${kvStorageStateRecord.updatedAt ? ` (updated ${kvStorageStateRecord.updatedAt})` : ''}.`,
              ],
            };
            researchAuthCache[marketplace] = {
              expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
              value,
            };
            return value;
          }
          shouldAttemptLegacyKvFallback = false;
          if (isExplicitResearchAuthRejection(validation)) {
            await deleteResearchSessionFromKv(marketplace);
            notes.push(
              `Deleted invalid canonical eBay Research storage state from ${store.backendName} after explicit auth rejection.`
            );
          } else {
            notes.push(
              `Preserved canonical eBay Research storage state in ${store.backendName} because validation did not return an explicit auth rejection.`
            );
          }
        } else {
          await deleteCanonicalResearchStorageStateFromKv(marketplace);
          notes.push(
            `Deleted unusable canonical eBay Research storage state from ${store.backendName} because no usable cookies could be restored.`
          );
        }
      } else {
        notes.push(
          `Canonical eBay Research storage state in ${store.backendName} could not be parsed as Playwright storage-state JSON.`
        );
        await deleteCanonicalResearchStorageStateFromKv(marketplace);
        notes.push(
          `Deleted malformed canonical eBay Research storage state from ${store.backendName} before attempting legacy fallback.`
        );
      }
    }

    const persistedSession = await readResearchSessionFromKv(marketplace);
    if (shouldAttemptLegacyKvFallback && persistedSession?.storageState) {
      const resolvedSession = await resolveStorageStateCookies(
        persistedSession.storageState,
        `${store.backendName} legacy KV storage state`,
        notes
      );
      if (resolvedSession && resolvedSession.cookies.length > 0) {
        diagnostics.kvLoadSucceeded = true;
        diagnostics.kvStorageStateBytes = Buffer.byteLength(
          JSON.stringify(persistedSession.storageState),
          'utf8'
        );
        diagnostics.authValidationAttempted = true;
        const validation = await validateResearchAuthState({
          marketplace,
          cookies: resolvedSession.cookies,
          sourceLabel: `${store.backendName} legacy KV storage state`,
        });
        diagnostics.authValidationSucceeded = validation.ok;
        notes.push(validation.note);
        if (!validation.ok) {
          if (isExplicitResearchAuthRejection(validation)) {
            await deleteResearchSessionFromKv(marketplace);
            notes.push(
              `Deleted invalid legacy eBay Research KV session from ${store.backendName} after explicit auth rejection.`
            );
          } else {
            notes.push(
              `Preserved legacy eBay Research KV session in ${store.backendName} because validation did not return an explicit auth rejection.`
            );
          }
        } else {
          const value: ResearchAuthState = {
            cookies: resolvedSession.cookies,
            storageState: resolvedSession.storageState,
            authState: 'loaded',
            sessionStrategy: 'storage_state',
            ...diagnostics,
            sessionSource: 'kv',
            notes: [...notes, `Restored eBay Research storage state from ${store.backendName}.`],
          };
          researchAuthCache[marketplace] = {
            expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
            value,
          };
          return value;
        }
      }
    }

    if (shouldAttemptLegacyKvFallback && persistedSession?.cookies?.length) {
      diagnostics.kvLoadSucceeded = true;
      diagnostics.authValidationAttempted = true;
      const validation = await validateResearchAuthState({
        marketplace,
        cookies: persistedSession.cookies,
        sourceLabel: `${store.backendName} legacy KV cookie session`,
      });
      diagnostics.authValidationSucceeded = validation.ok;
      notes.push(validation.note);
      if (!validation.ok) {
        if (isExplicitResearchAuthRejection(validation)) {
          await deleteResearchSessionFromKv(marketplace);
          notes.push(
            `Deleted invalid legacy eBay Research cookie session from ${store.backendName} after explicit auth rejection.`
          );
        } else {
          notes.push(
            `Preserved legacy eBay Research cookie session in ${store.backendName} because validation did not return an explicit auth rejection.`
          );
        }
      } else {
        const value: ResearchAuthState = {
          cookies: persistedSession.cookies,
          storageState:
            persistedSession.storageState ?? storageStateFromCookies(persistedSession.cookies),
          authState: 'loaded',
          sessionStrategy: persistedSession.source ?? 'kv_store',
          ...diagnostics,
          sessionSource: 'kv',
          notes: [...notes, `Restored eBay Research cookie session from ${store.backendName}.`],
        };
        researchAuthCache[marketplace] = {
          expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
          value,
        };
        return value;
      }
    }

    notes.push(
      `No persisted eBay Research session was found in ${store.backendName} under canonical or legacy keys.`
    );
  } else {
    notes.push(
      'Shared KV store for eBay Research sessions is unavailable; runtime will continue with non-KV fallbacks only.'
    );
  }

  if (envStorageStateRaw) {
    diagnostics.envLoadAttempted = true;
    try {
      const storageState = normalizeStorageState(JSON.parse(envStorageStateRaw) as unknown);
      if (storageState) {
        const resolvedSession = await resolveStorageStateCookies(
          storageState,
          `${RESEARCH_STORAGE_STATE_ENV_KEY}`,
          notes
        );
        if (resolvedSession && resolvedSession.cookies.length > 0) {
          diagnostics.envLoadSucceeded = true;
          diagnostics.authValidationAttempted = true;
          const validation = await validateResearchAuthState({
            marketplace,
            cookies: resolvedSession.cookies,
            sourceLabel: `${RESEARCH_STORAGE_STATE_ENV_KEY}`,
          });
          diagnostics.authValidationSucceeded = validation.ok;
          notes.push(validation.note);
          if (!validation.ok) {
            notes.push(
              `${RESEARCH_STORAGE_STATE_ENV_KEY} was ignored because validation against the ACTIVE endpoint failed.`
            );
          } else {
            const value: ResearchAuthState = {
              cookies: resolvedSession.cookies,
              storageState: resolvedSession.storageState,
              authState: 'loaded',
              sessionStrategy: 'storage_state',
              ...diagnostics,
              sessionSource: 'env',
              notes,
            };
            await persistResearchSessionToKv({
              marketplace,
              cookies: resolvedSession.cookies,
              storageState: resolvedSession.storageState,
              source: value.sessionStrategy,
              sessionSource: value.sessionSource,
            });
            researchAuthCache[marketplace] = {
              expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
              value,
            };
            return value;
          }
        }
      } else {
        notes.push(
          `${RESEARCH_STORAGE_STATE_ENV_KEY} did not contain a valid Playwright storage state.`
        );
      }
    } catch {
      notes.push(`${RESEARCH_STORAGE_STATE_ENV_KEY} could not be parsed as JSON.`);
    }
  }

  if (envCookiesRaw) {
    diagnostics.envLoadAttempted = true;
    try {
      const cookies = normalizeResearchCookies(JSON.parse(envCookiesRaw) as unknown);
      if (cookies.length > 0) {
        diagnostics.envLoadSucceeded = true;
        diagnostics.authValidationAttempted = true;
        const validation = await validateResearchAuthState({
          marketplace,
          cookies,
          sourceLabel: 'EBAY_RESEARCH_COOKIES_JSON',
        });
        diagnostics.authValidationSucceeded = validation.ok;
        notes.push(validation.note);
        if (!validation.ok) {
          notes.push(
            'EBAY_RESEARCH_COOKIES_JSON was ignored because validation against the ACTIVE endpoint failed.'
          );
        } else {
          const value: ResearchAuthState = {
            cookies,
            storageState: storageStateFromCookies(cookies),
            authState: 'loaded',
            sessionStrategy: 'env_cookies',
            ...diagnostics,
            sessionSource: 'env',
            notes,
          };
          await persistResearchSessionToKv({
            marketplace,
            cookies,
            storageState: value.storageState,
            source: value.sessionStrategy,
            sessionSource: value.sessionSource,
          });
          researchAuthCache[marketplace] = {
            expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
            value,
          };
          return value;
        }
      }
      notes.push('EBAY_RESEARCH_COOKIES_JSON did not contain any usable cookies.');
    } catch {
      notes.push('EBAY_RESEARCH_COOKIES_JSON could not be parsed as JSON.');
    }
  }

  const storageStatePath = toAbsolutePath(RESEARCH_STORAGE_STATE_PATH);
  diagnostics.filesystemLoadAttempted = true;
  const storageState = await readStorageStateFile(storageStatePath);
  if (storageState) {
    const resolvedSession = await resolveStorageStateCookies(
      storageState,
      `storage state file at ${storageStatePath}`,
      notes
    );
    if (resolvedSession && resolvedSession.cookies.length > 0) {
      diagnostics.filesystemLoadSucceeded = true;
      diagnostics.authValidationAttempted = true;
      const validation = await validateResearchAuthState({
        marketplace,
        cookies: resolvedSession.cookies,
        sourceLabel: `storage state file at ${storageStatePath}`,
      });
      diagnostics.authValidationSucceeded = validation.ok;
      notes.push(validation.note);
      if (!validation.ok) {
        notes.push(
          `Storage state file at ${storageStatePath} was ignored because validation against the ACTIVE endpoint failed.`
        );
      } else {
        const value: ResearchAuthState = {
          cookies: resolvedSession.cookies,
          storageState: resolvedSession.storageState,
          authState: 'loaded',
          sessionStrategy: 'storage_state',
          ...diagnostics,
          sessionSource: 'filesystem',
          notes,
        };
        await persistResearchSessionToKv({
          marketplace,
          cookies: resolvedSession.cookies,
          storageState: resolvedSession.storageState,
          source: value.sessionStrategy,
          sessionSource: value.sessionSource,
        });
        researchAuthCache[marketplace] = {
          expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
          value,
        };
        return value;
      }
    }
  } else {
    notes.push(`No research storage state found at ${storageStatePath}.`);
  }

  const profileDir = toAbsolutePath(RESEARCH_PROFILE_DIR);
  diagnostics.profileLoadAttempted = true;
  const profileState = await readPlaywrightProfileState(profileDir, notes);
  if (profileState && profileState.cookies.length > 0) {
    diagnostics.profileLoadSucceeded = true;
    diagnostics.authValidationAttempted = true;
    const validation = await validateResearchAuthState({
      marketplace,
      cookies: profileState.cookies,
      sourceLabel: `Playwright profile at ${profileDir}`,
    });
    diagnostics.authValidationSucceeded = validation.ok;
    notes.push(validation.note);
    if (!validation.ok) {
      notes.push(
        `Playwright profile at ${profileDir} was ignored because validation against the ACTIVE endpoint failed.`
      );
    } else {
      const value: ResearchAuthState = {
        cookies: profileState.cookies,
        storageState: profileState.storageState,
        authState: 'loaded',
        sessionStrategy: 'playwright_profile',
        ...diagnostics,
        sessionSource: 'playwright_profile',
        notes,
      };
      await persistResearchSessionToKv({
        marketplace,
        cookies: profileState.cookies,
        storageState: profileState.storageState,
        source: value.sessionStrategy,
        sessionSource: value.sessionSource,
      });
      researchAuthCache[marketplace] = {
        expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
        value,
      };
      return value;
    }
  }

  if (!existsSync(profileDir)) {
    notes.push(`No Playwright profile found at ${profileDir}.`);
  } else {
    notes.push('Playwright profile exists but cookies could not be restored.');
  }

  const value: ResearchAuthState = {
    cookies: [],
    storageState: null,
    authState: 'missing',
    sessionStrategy: 'none',
    ...diagnostics,
    sessionSource: null,
    notes,
  };
  researchAuthCache[marketplace] = {
    expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
    value,
  };
  return value;
}

async function fetchResearchTab(
  query: string,
  tabName: 'ACTIVE' | 'SOLD',
  options: Required<FetchEbayResearchOptions>,
  authState: ResearchAuthState
): Promise<ResearchTabFetchResult> {
  const cacheKey = getResearchTabCacheKey(query, tabName, options, authState);
  const cached = researchResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const requestUrl = buildResearchUrl(query, tabName, options);
  const cookieHeader = buildCookieHeader(authState.cookies);
  if (!cookieHeader) {
    throw new EbayResearchAuthError(
      'Authenticated eBay Research session is not available. Bootstrap a signed-in Playwright profile or provide storage-state cookies.'
    );
  }

  const response = await axios.get<string>(requestUrl, {
    responseType: 'text',
    headers: {
      accept: 'application/json, text/plain, */*',
      cookie: cookieHeader,
      'x-requested-with': 'XMLHttpRequest',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    },
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status === 401 || response.status === 403) {
    invalidateResearchAuthValidationCache(options.marketplace, authState.cookies);
    delete researchAuthCache[options.marketplace];
    await deleteResearchSessionFromKv(options.marketplace);
    throw new EbayResearchAuthError(
      `Authenticated eBay Research session was rejected with status ${response.status}.`
    );
  }

  const parsedPayload = parseResearchModules(response.data);
  const result: ResearchTabFetchResult = {
    modules: parsedPayload.modules,
    modulesSeen: parsedPayload.modulesSeen,
    moduleCount: parsedPayload.moduleCount,
    parseErrors: parsedPayload.parseErrors,
    pageErrors: extractPageErrors(parsedPayload.modules),
    responseStatus: response.status,
    cacheKey,
    cacheEligible: response.status >= 200 && response.status < 300,
  };

  return result;
}

function getDefaultFetchOptions(
  options?: FetchEbayResearchOptions
): Required<FetchEbayResearchOptions> {
  const dayRange = options?.dayRange ?? DEFAULT_DAY_RANGE;
  const endDate = options?.endDate ?? Date.now();
  const startDate = options?.startDate ?? endDate - dayRange * DAY_MS;

  return {
    marketplace: options?.marketplace ?? DEFAULT_MARKETPLACE,
    dayRange,
    timezone: options?.timezone ?? DEFAULT_TIMEZONE,
    startDate,
    endDate,
    offset: options?.offset ?? 0,
    limit: options?.limit ?? DEFAULT_LIMIT,
  };
}

export async function fetchEbayResearch(
  query: string,
  options?: FetchEbayResearchOptions
): Promise<EbayResearchResponse> {
  const normalizedQuery = query.trim();
  const resolvedOptions = getDefaultFetchOptions(options);
  const fetchedAt = new Date().toISOString();
  const activeEndpointUrl = buildResearchUrl(normalizedQuery, 'ACTIVE', resolvedOptions);
  const soldEndpointUrl = buildResearchUrl(normalizedQuery, 'SOLD', resolvedOptions);
  const authState = await resolveResearchAuthState(resolvedOptions.marketplace);

  try {
    const [activeResult, soldResult] = await Promise.all([
      fetchResearchTab(normalizedQuery, 'ACTIVE', resolvedOptions, authState),
      fetchResearchTab(normalizedQuery, 'SOLD', resolvedOptions, authState),
    ]);

    const activeAggregateModule = activeResult.modules.find((module) =>
      /ResearchAggregateModule/i.test(module.moduleName)
    )?.raw;
    const activeSearchResultsModule = activeResult.modules.find((module) =>
      /ActiveSearchResultsModule/i.test(module.moduleName)
    )?.raw;
    const soldAggregateModule = soldResult.modules.find((module) =>
      /ResearchAggregateModule/i.test(module.moduleName)
    )?.raw;
    const soldSearchResultsModule = soldResult.modules.find((module) =>
      /SearchResultsModule/i.test(module.moduleName)
    )?.raw;

    const activeAggregate = parseActiveAggregate(activeAggregateModule);
    const activeRows = parseActiveRows(activeSearchResultsModule);
    const watcherMetrics = buildWatcherMetrics(activeRows);
    const soldAggregate = parseSoldAggregate(soldAggregateModule);
    const soldRows = parseSoldRows(soldSearchResultsModule);
    const activeAggregateExtracted = aggregateHasUsefulValues({
      avgListingPriceUsd: activeAggregate.avgListingPriceUsd,
      listingPriceMinUsd: activeAggregate.listingPriceMinUsd,
      listingPriceMaxUsd: activeAggregate.listingPriceMaxUsd,
      avgShippingUsd: activeAggregate.avgShippingUsd,
      freeShippingPct: activeAggregate.freeShippingPct,
      totalActiveListings: activeAggregate.totalActiveListings,
      promotedListingsPct: activeAggregate.promotedListingsPct,
    });
    const soldAggregateExtracted = aggregateHasUsefulValues({
      avgSoldPriceUsd: soldAggregate.avgSoldPriceUsd,
      soldPriceMinUsd: soldAggregate.soldPriceMinUsd,
      soldPriceMaxUsd: soldAggregate.soldPriceMaxUsd,
      avgShippingUsd: soldAggregate.avgShippingUsd,
      freeShippingPct: soldAggregate.freeShippingPct,
      sellThroughPct: soldAggregate.sellThroughPct,
      totalSold: soldAggregate.totalSold,
      totalSellers: soldAggregate.totalSellers,
      totalItemSalesUsd: soldAggregate.totalItemSalesUsd,
    });
    const activeUsefulResponse = isUsefulActiveResearchPayload(activeAggregate, activeRows.length);
    const soldUsefulResponse = isUsefulSoldResearchPayload(soldAggregate, soldRows.length);
    const activeParse = buildResearchTabParseDebug({
      fetchResult: activeResult,
      aggregateExtracted: activeAggregateExtracted,
      rowCount: activeRows.length,
      watcherCoverageCount: watcherMetrics.watcherCoverageCount,
      usefulResponse: activeUsefulResponse,
    });
    const soldParse = buildResearchTabParseDebug({
      fetchResult: soldResult,
      aggregateExtracted: soldAggregateExtracted,
      rowCount: soldRows.length,
      usefulResponse: soldUsefulResponse,
    });
    const response: EbayResearchResponse = {
      active: {
        ...activeAggregate,
        avgWatchersPerListing: watcherMetrics.avgWatchersPerListing,
        watcherCoverageCount: watcherMetrics.watcherCoverageCount,
        listingRows: activeRows,
      },
      sold: {
        ...soldAggregate,
        soldRows,
      },
      debug: {
        query: normalizedQuery,
        activeEndpointUrl,
        soldEndpointUrl,
        fetchedAt,
        modulesSeen: uniqueStrings([...activeResult.modulesSeen, ...soldResult.modulesSeen]),
        pageErrors: uniqueStrings([...activeResult.pageErrors, ...soldResult.pageErrors]),
        activeParse,
        soldParse,
        usefulResponse: activeUsefulResponse || soldUsefulResponse,
        ...buildResearchAuthDebug(authState),
        notes: [...authState.notes],
      },
    };

    if (!hasUsefulResearchPayload(response)) {
      throw new Error(
        'eBay Research response did not include useful ACTIVE or SOLD modules after parsing.'
      );
    }

    if (
      activeResult.cacheEligible &&
      (activeAggregateModule !== undefined || activeSearchResultsModule !== undefined)
    ) {
      setResearchResponseCache(activeResult.cacheKey, 'ACTIVE', activeResult);
    }

    if (
      soldResult.cacheEligible &&
      (soldAggregateModule !== undefined || soldSearchResultsModule !== undefined)
    ) {
      setResearchResponseCache(soldResult.cacheKey, 'SOLD', soldResult);
    }

    return response;
  } catch (error) {
    if (error instanceof EbayResearchAuthError) {
      return {
        active: {
          avgListingPriceUsd: null,
          listingPriceMinUsd: null,
          listingPriceMaxUsd: null,
          avgShippingUsd: null,
          freeShippingPct: null,
          totalActiveListings: null,
          promotedListingsPct: null,
          avgWatchersPerListing: null,
          watcherCoverageCount: null,
          listingRows: [],
        },
        sold: {
          avgSoldPriceUsd: null,
          soldPriceMinUsd: null,
          soldPriceMaxUsd: null,
          avgShippingUsd: null,
          freeShippingPct: null,
          sellThroughPct: null,
          totalSold: null,
          totalSellers: null,
          totalItemSalesUsd: null,
          soldRows: [],
        },
        debug: {
          query: normalizedQuery,
          activeEndpointUrl,
          soldEndpointUrl,
          fetchedAt,
          modulesSeen: [],
          pageErrors: [],
          activeParse: {
            modulesSeen: [],
            moduleCount: 0,
            parseErrors: [],
            pageErrors: [],
            aggregateExtracted: false,
            rowCount: 0,
            watcherCoverageCount: 0,
            usefulResponse: false,
          },
          soldParse: {
            modulesSeen: [],
            moduleCount: 0,
            parseErrors: [],
            pageErrors: [],
            aggregateExtracted: false,
            rowCount: 0,
            watcherCoverageCount: 0,
            usefulResponse: false,
          },
          usefulResponse: false,
          ...buildResearchAuthDebug({
            ...authState,
            authState: authState.cookies.length > 0 ? 'expired' : authState.authState,
          }),
          notes: [...authState.notes, error.message],
        },
      };
    }

    throw error;
  }
}

export interface EbayResearchAuthInspection {
  authState: EbayResearchResponse['debug']['authState'];
  sessionStrategy: EbayResearchResponse['debug']['sessionStrategy'];
  sessionSource: EbayResearchResponse['debug']['sessionSource'];
  kvLoadAttempted: EbayResearchResponse['debug']['kvLoadAttempted'];
  kvLoadSucceeded: EbayResearchResponse['debug']['kvLoadSucceeded'];
  kvStorageStateBytes: EbayResearchResponse['debug']['kvStorageStateBytes'];
  envLoadAttempted: EbayResearchResponse['debug']['envLoadAttempted'];
  envLoadSucceeded: EbayResearchResponse['debug']['envLoadSucceeded'];
  filesystemLoadAttempted: EbayResearchResponse['debug']['filesystemLoadAttempted'];
  filesystemLoadSucceeded: EbayResearchResponse['debug']['filesystemLoadSucceeded'];
  profileLoadAttempted: EbayResearchResponse['debug']['profileLoadAttempted'];
  profileLoadSucceeded: EbayResearchResponse['debug']['profileLoadSucceeded'];
  authValidationAttempted: EbayResearchResponse['debug']['authValidationAttempted'];
  authValidationSucceeded: EbayResearchResponse['debug']['authValidationSucceeded'];
  notes: EbayResearchResponse['debug']['notes'];
  cookieCount: number;
}

export async function storeEbayResearchSessionToKv(
  marketplace: string,
  storageState: ResearchStorageState,
  source: ResearchSessionStrategy = 'storage_state'
): Promise<void> {
  const sanitizedStorageState = sanitizeResearchStorageState(
    storageState,
    'provided eBay Research storage state'
  );
  const cookies = normalizeResearchCookies(sanitizedStorageState.cookies);
  if (cookies.length === 0) {
    throw new EbayResearchAuthError(
      'Provided eBay Research storage state did not contain any usable cookies.'
    );
  }

  await persistResearchSessionToKv({
    marketplace,
    cookies,
    storageState: sanitizedStorageState,
    source,
    sessionSource: 'kv',
  });
}

export function clearEbayResearchAuthCache(): void {
  researchAuthCache = {};
  researchAuthValidationCache = {};
}

export async function inspectEbayResearchAuthState(
  marketplace: string
): Promise<EbayResearchAuthInspection> {
  const authState = await resolveResearchAuthState(marketplace);
  return {
    ...buildResearchAuthDebug(authState),
    notes: [...authState.notes],
    cookieCount: authState.cookies.length,
  };
}
