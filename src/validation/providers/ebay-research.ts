import axios from 'axios';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger } from '@/utils/logger.js';
import {
  createFreshEbayResearchSessionStoreResolution,
  getEbayResearchSessionStoreScopeSummary,
  getEbayResearchSessionStoreTargetSummary,
  isKvEbayResearchSessionStoreBackend,
  type EbayResearchSessionStoreBackend,
  type EbayResearchSessionStoreMeta,
  type EbayResearchSessionStoreResolution,
} from './ebay-research-session-store.js';

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
type ResearchAntiBotChallengeKind =
  | 'ebay_pardon_interruption'
  | 'captcha_challenge'
  | 'html_interstitial';

export interface ResearchAntiBotDetection {
  detected: boolean;
  kind: ResearchAntiBotChallengeKind | null;
  title: string | null;
  contentType: string | null;
  matchedSignals: string[];
}

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
    antiBotDetection?: ResearchAntiBotDetection;
    activeParse?: ResearchTabParseDebug;
    soldParse?: ResearchTabParseDebug;
    usefulResponse?: boolean;
    authState: ResearchDebugAuthState;
    sessionStrategy: ResearchSessionStrategy;
    sessionSource: ResearchSessionSource;
    sessionStoreConfigured: EbayResearchSessionStoreBackend;
    sessionStoreSelected: EbayResearchSessionStoreBackend;
    kvLoadAttempted: boolean;
    kvLoadSucceeded: boolean;
    cfKvLoadAttempted: boolean;
    cfKvLoadSucceeded: boolean;
    upstashLoadAttempted: boolean;
    upstashLoadSucceeded: boolean;
    kvStorageStateBytes: number | null;
    storageStateBytes: number | null;
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
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
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
  antiBotDetection?: ResearchAntiBotDetection;
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
  antiBotDetection: ResearchAntiBotDetection;
  responseStatus: number;
  contentType: string | null;
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
  sessionStoreConfigured: EbayResearchSessionStoreBackend;
  sessionStoreSelected: EbayResearchSessionStoreBackend;
  kvLoadAttempted: boolean;
  kvLoadSucceeded: boolean;
  cfKvLoadAttempted: boolean;
  cfKvLoadSucceeded: boolean;
  upstashLoadAttempted: boolean;
  upstashLoadSucceeded: boolean;
  kvStorageStateBytes: number | null;
  storageStateBytes: number | null;
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

interface PersistedKvStorageStateRecord {
  raw: string;
  parsed: ResearchStorageState | null;
  bytes: number;
  meta: EbayResearchSessionStoreMeta | null;
  updatedAt: string | null;
  source: string | null;
}

interface ResearchSessionValidationResult {
  ok: boolean;
  responseStatus: number | null;
  modulesSeen: string[];
  antiBotDetection?: ResearchAntiBotDetection;
  note: string;
}

/** Maximum consecutive auth failures before session deletion (grace period). */
const RESEARCH_SESSION_MAX_FAILURES_BEFORE_DELETE = 3;
/** Cooldown (ms) after a deletion before another deletion is considered. Prevents rapid re-deletion. */
const RESEARCH_SESSION_DELETION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

interface ResearchSessionDegradationState {
  consecutiveFailures: number;
  lastFailureAt: string;
  lastFailurePath: 'auth_rejection' | 'no_cookies' | 'parse_failure' | 'anti_bot_challenge';
  lastFailureDetail: string;
}

function isExplicitResearchAuthRejection(validation: ResearchSessionValidationResult): boolean {
  return validation.responseStatus === 401 || validation.responseStatus === 403;
}

function readDegradationState(
  meta: EbayResearchSessionStoreMeta | null
): ResearchSessionDegradationState | null {
  if (!meta) return null;
  const raw = (meta as Record<string, unknown>).__degradation as
    | Record<string, unknown>
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  return {
    consecutiveFailures: typeof raw.consecutiveFailures === 'number' ? raw.consecutiveFailures : 0,
    lastFailureAt: typeof raw.lastFailureAt === 'string' ? raw.lastFailureAt : '',
    lastFailurePath:
      typeof raw.lastFailurePath === 'string'
        ? (raw.lastFailurePath as ResearchSessionDegradationState['lastFailurePath'])
        : 'auth_rejection',
    lastFailureDetail: typeof raw.lastFailureDetail === 'string' ? raw.lastFailureDetail : '',
  };
}

function buildDegradationMeta(
  baseMeta: EbayResearchSessionStoreMeta,
  degradation: ResearchSessionDegradationState
): EbayResearchSessionStoreMeta {
  return {
    ...baseMeta,
    __degradation: degradation,
  };
}

async function updateDegradationMeta(
  resolution: EbayResearchSessionStoreResolution,
  degradation: ResearchSessionDegradationState,
  existingMeta: EbayResearchSessionStoreMeta | null
): Promise<void> {
  if (!resolution.store) return;
  try {
    const updatedMeta = existingMeta
      ? buildDegradationMeta(existingMeta, degradation)
      : ({
          updatedAt: new Date().toISOString(),
          expiresAt: null,
          ttlSeconds: RESEARCH_SESSION_STORE_TTL_S,
          storeTtlSeconds: RESEARCH_SESSION_STORE_TTL_S,
          backend: resolution.selected,
          sessionStore: resolution.selected,
          marketplace: 'EBAY-US',
          source: 'storage_state',
          sessionVersion: new Date().toISOString(),
          sessionSource: 'kv',
          storageStateBytes: 0,
          __degradation: degradation,
        } as EbayResearchSessionStoreMeta);
    await resolution.store.setMeta(updatedMeta, { ttlSeconds: RESEARCH_SESSION_STORE_TTL_S });
  } catch {
    // Meta update failure is non-fatal — session deletion logic still proceeds
  }
}

function shouldSkipDeletion(meta: EbayResearchSessionStoreMeta | null): boolean {
  const degradation = readDegradationState(meta);
  if (!degradation) return false;
  // If we haven't reached max failures yet, skip deletion
  if (degradation.consecutiveFailures < RESEARCH_SESSION_MAX_FAILURES_BEFORE_DELETE) {
    return true;
  }
  // If within cooldown, skip deletion
  if (degradation.lastFailureAt) {
    const lastFailureMs = new Date(degradation.lastFailureAt).getTime();
    if (Date.now() - lastFailureMs < RESEARCH_SESSION_DELETION_COOLDOWN_MS) {
      return true;
    }
  }
  return false;
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
const RESEARCH_STORAGE_STATE_META_PATH =
  process.env.EBAY_RESEARCH_STORAGE_STATE_META_PATH?.trim() ??
  `${RESEARCH_STORAGE_STATE_PATH}.meta.json`;
const RESEARCH_PROFILE_DIR =
  process.env.EBAY_RESEARCH_PROFILE_DIR?.trim() ?? '.ebay-research/profile';
const RESEARCH_COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESEARCH_AUTH_VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000;
const RESEARCH_SESSION_STORE_TTL_S = 179 * 24 * 60 * 60;
const RESEARCH_SESSION_FALLBACK_TTL_S = 30 * 24 * 60 * 60;
const RESEARCH_STORAGE_STATE_ENV_KEY = 'EBAY_RESEARCH_STORAGE_STATE_JSON';
const EBAY_HOSTNAME_PATTERN = /(^|\.)ebay\.[a-z.]+$/i;
const RESEARCH_SESSION_ALLOW_FILESYSTEM_FALLBACK =
  process.env.EBAY_RESEARCH_SESSION_ALLOW_FILESYSTEM_FALLBACK?.trim().toLowerCase() === 'true';
const RESEARCH_SESSION_LOG_PREFIX = '[eBayResearchSession]';
const researchSessionLogger = createLogger('eBayResearchSession');

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

function getResponseHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  const accessor = (headers as { get?: (key: string) => unknown }).get;
  if (typeof accessor === 'function') {
    const value = accessor.call(headers, name);
    return typeof value === 'string' ? value : null;
  }

  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === normalizedName) {
      return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : null;
    }
  }

  return null;
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

function logResearchSession(message: string): void {
  researchSessionLogger.info(`${RESEARCH_SESSION_LOG_PREFIX} ${message}`);
}

function describeStoredValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

function getStoredValueBytes(value: unknown): number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }

  if (value === null || value === undefined) {
    return 0;
  }

  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function getStoredStorageStateValidityFromUnknown(value: unknown): boolean | null {
  if (typeof value === 'string') {
    return getStoredStorageStateValidity(value);
  }

  if (value === null || value === undefined) {
    return null;
  }

  return normalizeStorageState(value) !== null;
}

function resolveResearchSessionStore(marketplace: string): EbayResearchSessionStoreResolution {
  // Research sessions are commonly refreshed out-of-band by the bootstrap CLI or
  // hosted admin endpoint while the HTTP worker is already running. Use a fresh
  // KV client for canonical reads/writes so a stale process-local read-through
  // cache (especially cached Upstash misses) cannot hide newly written cookies.
  return createFreshEbayResearchSessionStoreResolution(marketplace);
}

export interface EbayResearchFreshStoreValueInspection {
  attempted: boolean;
  backend: EbayResearchSessionStoreBackend;
  configuredFrom: 'env' | 'legacy_token_store' | 'default';
  rawConfiguredValue: string | null;
  connection: string | null;
  credentialsConfigured: boolean;
  credentialFingerprint: string | null;
  environment: string;
  marketplace: string;
  stateKeyScope: 'base' | 'scoped';
  key: string | null;
  exists: boolean;
  valueType: string;
  bytes: number;
  validPlaywrightStorageStateJson: boolean | null;
  summary: string | null;
  error: string | null;
}

function truncateForLog(value: string, maxLength = 100): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

function summarizeStoredValueWithoutContent(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 'string(len=0, empty=true)';
    }

    const parsedSummary = (() => {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return `jsonParse=array(len=${parsed.length})`;
        }

        if (parsed && typeof parsed === 'object') {
          return `jsonParse=object(keys=${Object.keys(parsed).slice(0, 5).join(',')})`;
        }

        return `jsonParse=${typeof parsed}`;
      } catch {
        return 'jsonParse=failed';
      }
    })();

    return truncateForLog(
      `string(len=${value.length}, startsWith=${JSON.stringify(trimmed.slice(0, 1))}, ${parsedSummary})`
    );
  }

  if (Array.isArray(value)) {
    return truncateForLog(`array(len=${value.length})`);
  }

  if (typeof value === 'object') {
    return truncateForLog(`object(keys=${Object.keys(value).slice(0, 8).join(',')})`);
  }

  return truncateForLog(`primitive(type=${typeof value})`);
}

async function inspectFreshCanonicalStorageState(
  marketplace: string
): Promise<EbayResearchFreshStoreValueInspection> {
  const resolution = createFreshEbayResearchSessionStoreResolution(marketplace);
  const target = getEbayResearchSessionStoreTargetSummary(resolution.selected);
  const scope = getEbayResearchSessionStoreScopeSummary(marketplace);

  if (!resolution.store || !resolution.stateKey) {
    return {
      attempted: false,
      backend: resolution.selected,
      configuredFrom: resolution.configuredFrom,
      rawConfiguredValue: resolution.rawConfiguredValue,
      connection: target.connection,
      credentialsConfigured: target.credentialsConfigured,
      credentialFingerprint: target.credentialFingerprint,
      environment: scope.environment,
      marketplace: scope.marketplace,
      stateKeyScope: scope.stateKeyScope,
      key: resolution.stateKey,
      exists: false,
      valueType: 'null',
      bytes: 0,
      validPlaywrightStorageStateJson: null,
      summary: null,
      error: resolution.error,
    };
  }

  try {
    const rawStorageState = await resolution.store.getStorageState();
    return {
      attempted: true,
      backend: resolution.selected,
      configuredFrom: resolution.configuredFrom,
      rawConfiguredValue: resolution.rawConfiguredValue,
      connection: target.connection,
      credentialsConfigured: target.credentialsConfigured,
      credentialFingerprint: target.credentialFingerprint,
      environment: scope.environment,
      marketplace: scope.marketplace,
      stateKeyScope: scope.stateKeyScope,
      key: resolution.stateKey,
      exists: typeof rawStorageState === 'string' && rawStorageState.length > 0,
      valueType: describeStoredValueType(rawStorageState),
      bytes: getStoredValueBytes(rawStorageState),
      validPlaywrightStorageStateJson: getStoredStorageStateValidityFromUnknown(rawStorageState),
      summary: summarizeStoredValueWithoutContent(rawStorageState),
      error: null,
    };
  } catch (error) {
    return {
      attempted: true,
      backend: resolution.selected,
      configuredFrom: resolution.configuredFrom,
      rawConfiguredValue: resolution.rawConfiguredValue,
      connection: target.connection,
      credentialsConfigured: target.credentialsConfigured,
      credentialFingerprint: target.credentialFingerprint,
      environment: scope.environment,
      marketplace: scope.marketplace,
      stateKeyScope: scope.stateKeyScope,
      key: resolution.stateKey,
      exists: false,
      valueType: 'error',
      bytes: 0,
      validPlaywrightStorageStateJson: null,
      summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getSessionSourceForStoreBackend(
  backend: EbayResearchSessionStoreBackend
): Extract<ResearchSessionSource, 'kv' | 'filesystem'> | null {
  if (isKvEbayResearchSessionStoreBackend(backend)) {
    return 'kv';
  }

  if (backend === 'filesystem') {
    return 'filesystem';
  }

  return null;
}

function shouldAttemptFilesystemFallback(
  selectedBackend: EbayResearchSessionStoreBackend
): boolean {
  return (
    selectedBackend === 'filesystem' ||
    (isKvEbayResearchSessionStoreBackend(selectedBackend) &&
      RESEARCH_SESSION_ALLOW_FILESYSTEM_FALLBACK) ||
    (selectedBackend === 'none' && RESEARCH_SESSION_ALLOW_FILESYSTEM_FALLBACK)
  );
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

function normalizeResearchCookieSameSite(value: unknown): ResearchCookie['sameSite'] {
  if (typeof value !== 'string') {
    return 'Lax';
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, '');
  if (normalized === 'strict') {
    return 'Strict';
  }
  if (normalized === 'none' || normalized === 'norestriction' || normalized === 'no_restriction') {
    return 'None';
  }
  return 'Lax';
}

function normalizeResearchCookieExpires(entry: Record<string, unknown>): number {
  const rawExpires = entry.expires ?? entry.expirationDate ?? entry.expiration;
  return typeof rawExpires === 'number' && Number.isFinite(rawExpires) ? rawExpires : -1;
}

function normalizeResearchCookie(entry: Record<string, unknown>): ResearchCookie {
  return {
    name: typeof entry.name === 'string' ? entry.name : '',
    value: typeof entry.value === 'string' ? entry.value : '',
    domain:
      typeof entry.domain === 'string' && entry.domain.trim().length > 0
        ? entry.domain
        : '.ebay.com',
    path: typeof entry.path === 'string' && entry.path.trim().length > 0 ? entry.path : '/',
    expires: normalizeResearchCookieExpires(entry),
    httpOnly: typeof entry.httpOnly === 'boolean' ? entry.httpOnly : false,
    secure: typeof entry.secure === 'boolean' ? entry.secure : true,
    sameSite: normalizeResearchCookieSameSite(entry.sameSite),
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

function getStoredStorageStateValidity(value: string | null): boolean | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  try {
    return normalizeStorageState(JSON.parse(value) as unknown) !== null;
  } catch {
    return false;
  }
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
  const cookies = normalizeResearchCookies(storageState.cookies).filter((cookie) => {
    // normalizeResearchCookie fills missing manual-export domain/path metadata
    // with safe ebay.com defaults, then this filter removes explicitly
    // non-eBay cookies before persistence/use.
    if (typeof cookie.domain !== 'string' || cookie.domain.length === 0) {
      return true;
    }
    return isEbayResearchHostname(cookie.domain);
  });
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

function buildResearchAuthDebug(authState: ResearchAuthState): Omit<
  EbayResearchResponse['debug'],
  | 'query'
  | 'activeEndpointUrl'
  | 'soldEndpointUrl'
  | 'fetchedAt'
  | 'modulesSeen'
  | 'pageErrors'
  | 'notes'
> & {
  errorCode?: string;
  authErrorDetail?: string;
  validationDebug?: {
    httpStatus?: number | null;
    validationModulesSeen?: string[];
    validationResponseBodyExcerpt?: string;
  };
  cookieDebug?: {
    cookieCount: number;
    cookieNames: string[];
    cookieDomains: string[];
    sampleCookies: string[];
  };
} {
  const errorCode = (() => {
    if (authState.cookies.length === 0 && authState.authState === 'missing')
      return 'AUTH_MISSING_NO_SOURCES';
    if (authState.cookies.length === 0 && authState.authState === 'expired')
      return 'AUTH_EXPIRED_NO_RECOVERY';
    if (authState.cookies.length > 0 && authState.authState === 'expired') return 'AUTH_EXPIRED';
    if (authState.authState === 'loaded' || authState.authState === 'authenticated') return 'NONE';
    return 'AUTH_UNKNOWN';
  })();

  const authErrorDetail = (() => {
    if (authState.authState === 'missing') {
      const sourcesAttempted = [];
      if (authState.kvLoadAttempted)
        sourcesAttempted.push(`kv(${authState.kvLoadSucceeded ? 'succeeded' : 'failed'})`);
      if (authState.envLoadAttempted)
        sourcesAttempted.push(`env(${authState.envLoadSucceeded ? 'succeeded' : 'failed'})`);
      if (authState.filesystemLoadAttempted)
        sourcesAttempted.push(
          `filesystem(${authState.filesystemLoadSucceeded ? 'succeeded' : 'failed'})`
        );
      if (authState.profileLoadAttempted)
        sourcesAttempted.push(
          `profile(${authState.profileLoadSucceeded ? 'succeeded' : 'failed'})`
        );
      return `No authenticated session found. Sources attempted: ${sourcesAttempted.join(', ') || 'none'}. Store: ${authState.sessionStoreSelected}.`;
    }
    if (authState.authState === 'expired') {
      return `Session expired. Cookies exist (${authState.cookies.length}) but validation failed. Validation: ${authState.authValidationAttempted ? 'attempted' : 'skipped'}, ${authState.authValidationSucceeded ? 'succeeded' : 'failed'}.`;
    }
    return undefined;
  })();

  const cookieDebug =
    authState.cookies.length > 0
      ? {
          cookieCount: authState.cookies.length,
          cookieNames: authState.cookies.map((c) => c.name),
          cookieDomains: [...new Set(authState.cookies.map((c) => c.domain ?? ''))].filter(Boolean),
          sampleCookies: authState.cookies
            .slice(0, 3)
            .map((c) => `${c.name}@${c.domain ?? 'none'}`),
        }
      : {
          cookieCount: 0,
          cookieNames: [],
          cookieDomains: [],
          sampleCookies: [],
        };

  return {
    authState: authState.authState,
    sessionStrategy: authState.sessionStrategy,
    sessionSource: authState.sessionSource,
    sessionStoreConfigured: authState.sessionStoreConfigured,
    sessionStoreSelected: authState.sessionStoreSelected,
    kvLoadAttempted: authState.kvLoadAttempted,
    kvLoadSucceeded: authState.kvLoadSucceeded,
    cfKvLoadAttempted: authState.cfKvLoadAttempted,
    cfKvLoadSucceeded: authState.cfKvLoadSucceeded,
    upstashLoadAttempted: authState.upstashLoadAttempted,
    upstashLoadSucceeded: authState.upstashLoadSucceeded,
    kvStorageStateBytes: authState.kvStorageStateBytes,
    storageStateBytes: authState.storageStateBytes,
    envLoadAttempted: authState.envLoadAttempted,
    envLoadSucceeded: authState.envLoadSucceeded,
    filesystemLoadAttempted: authState.filesystemLoadAttempted,
    filesystemLoadSucceeded: authState.filesystemLoadSucceeded,
    profileLoadAttempted: authState.profileLoadAttempted,
    profileLoadSucceeded: authState.profileLoadSucceeded,
    authValidationAttempted: authState.authValidationAttempted,
    authValidationSucceeded: authState.authValidationSucceeded,
    errorCode,
    authErrorDetail,
    cookieDebug,
  };
}

function buildValidationDebug(
  error: unknown,
  authState: ResearchAuthState
): {
  httpStatus: number | null;
  validationModulesSeen: string[];
  validationResponseBodyExcerpt: string | null;
  errorMessage: string;
} {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    httpStatus: (() => {
      const match = /HTTP (\d+)/.exec(msg);
      return match ? parseInt(match[1]) : null;
    })(),
    validationModulesSeen: authState.notes.filter((n) => n.includes('modulesSeen')),
    validationResponseBodyExcerpt: (() => {
      const match = /responseBody="(.*?)"/.exec(msg);
      return match ? match[1].slice(0, 500) : null;
    })(),
    errorMessage: msg,
  };
}

interface PlaywrightContext {
  cookies: (urls?: string | string[]) => Promise<ResearchCookie[]>;
  storageState: () => Promise<ResearchStorageState>;
  close: () => Promise<void>;
  newPage?: () => Promise<{
    goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  }>;
}

interface PlaywrightModule {
  chromium?: {
    launch?: (options: Record<string, unknown>) => Promise<{
      newContext: (options?: Record<string, unknown>) => Promise<PlaywrightContext>;
      close: () => Promise<void>;
    }>;
    launchPersistentContext?: (
      userDataDir: string,
      options: Record<string, unknown>
    ) => Promise<PlaywrightContext>;
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

async function readResearchStorageStateFromStore(
  resolution: EbayResearchSessionStoreResolution
): Promise<PersistedKvStorageStateRecord | null> {
  if (!resolution.store) {
    return null;
  }

  const [rawValue, meta] = await Promise.all([
    resolution.store.getStorageState(),
    resolution.store.getMeta(),
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
    meta,
    updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : null,
    source: typeof meta?.source === 'string' ? meta.source : null,
  };
}

async function persistResearchSessionToStore(options: {
  marketplace: string;
  cookies: ResearchCookie[];
  storageState?: ResearchStorageState | null;
  source: ResearchSessionStrategy;
  sessionSource?: ResearchSessionSource;
  required?: boolean;
}): Promise<{
  backend: EbayResearchSessionStoreBackend;
  stateKey: string | null;
  metaKey: string | null;
  bytes: number;
  updatedAt: string;
  expiresAt: string | null;
  ttlSeconds: number;
  storeTtlSeconds: number;
} | null> {
  const resolution = resolveResearchSessionStore(options.marketplace);
  const persistedStorageState = options.storageState
    ? sanitizeResearchStorageState(options.storageState)
    : null;
  const persistedCookies = persistedStorageState
    ? normalizeResearchCookies(persistedStorageState.cookies)
    : normalizeResearchCookies(options.cookies);

  if (persistedCookies.length === 0) {
    return null;
  }

  if (!resolution.store) {
    const message = resolution.error
      ? `Selected session store ${resolution.selected} is unavailable (${resolution.error}).`
      : `No eBay Research session store is configured (selected=${resolution.selected}).`;
    logResearchSession(message);
    if (options.required) {
      throw new EbayResearchAuthError(message);
    }
    return null;
  }

  const expiryMs = getCookieExpiryMs(persistedCookies);
  const ttlSeconds = expiryMs
    ? Math.max(
        60,
        Math.min(RESEARCH_SESSION_FALLBACK_TTL_S, Math.floor((expiryMs - Date.now()) / 1000))
      )
    : RESEARCH_SESSION_FALLBACK_TTL_S;
  const storeTtlSeconds = RESEARCH_SESSION_STORE_TTL_S;
  const updatedAt = new Date().toISOString();
  const expiresAt = expiryMs ? new Date(expiryMs).toISOString() : null;
  const serializedStorageState = JSON.stringify(
    persistedStorageState ?? storageStateFromCookies(persistedCookies)
  );
  const storageStateBytes = Buffer.byteLength(serializedStorageState, 'utf8');
  const meta: EbayResearchSessionStoreMeta = {
    updatedAt,
    expiresAt,
    ttlSeconds,
    storeTtlSeconds,
    backend: resolution.selected,
    sessionStore: resolution.selected,
    marketplace: options.marketplace,
    source: options.source,
    sessionVersion: updatedAt,
    sessionSource: options.sessionSource ?? getSessionSourceForStoreBackend(resolution.selected),
    storageStateBytes,
  };

  logResearchSession(
    `Persisting canonical eBay Research storage state backend=${resolution.selected} stateKey=${resolution.stateKey ?? 'null'} metaKey=${resolution.metaKey ?? 'null'} ttlSeconds=${ttlSeconds} storeTtlSeconds=${storeTtlSeconds} bytes=${storageStateBytes}`
  );

  await Promise.all([
    resolution.store.setStorageState(serializedStorageState, { ttlSeconds: storeTtlSeconds }),
    resolution.store.setMeta(meta, { ttlSeconds: storeTtlSeconds }),
  ]);

  const [canonicalReadback, metaReadback] = await Promise.all([
    resolution.store.getStorageState() as Promise<unknown>,
    resolution.store.getMeta(),
  ]);
  const freshCanonicalReadback = await inspectFreshCanonicalStorageState(options.marketplace);

  logResearchSession(
    `Canonical storage-state readback key=${resolution.stateKey ?? 'null'} type=${describeStoredValueType(canonicalReadback)} bytes=${getStoredValueBytes(canonicalReadback)} valid=${String(getStoredStorageStateValidityFromUnknown(canonicalReadback))}`
  );
  logResearchSession(
    `Fresh-client canonical readback backend=${freshCanonicalReadback.backend} key=${freshCanonicalReadback.key ?? 'null'} exists=${String(freshCanonicalReadback.exists)} type=${freshCanonicalReadback.valueType} bytes=${freshCanonicalReadback.bytes} valid=${String(freshCanonicalReadback.validPlaywrightStorageStateJson)} scope=${freshCanonicalReadback.stateKeyScope} environment=${freshCanonicalReadback.environment} marketplace=${freshCanonicalReadback.marketplace} configuredFrom=${freshCanonicalReadback.configuredFrom} rawConfiguredValue=${freshCanonicalReadback.rawConfiguredValue ?? 'null'} connection=${freshCanonicalReadback.connection ?? 'null'} credentialFingerprint=${freshCanonicalReadback.credentialFingerprint ?? 'null'} summary=${freshCanonicalReadback.summary ?? 'null'} error=${freshCanonicalReadback.error ?? 'null'}`
  );
  logResearchSession(
    `Metadata readback key=${resolution.metaKey ?? 'null'} exists=${String(metaReadback !== null)} storageStateBytes=${typeof metaReadback?.storageStateBytes === 'number' ? metaReadback.storageStateBytes : 'null'} updatedAt=${typeof metaReadback?.updatedAt === 'string' ? metaReadback.updatedAt : 'null'} expiresAt=${typeof metaReadback?.expiresAt === 'string' ? metaReadback.expiresAt : 'null'} ttlSeconds=${typeof metaReadback?.ttlSeconds === 'number' ? metaReadback.ttlSeconds : 'null'} storeTtlSeconds=${typeof metaReadback?.storeTtlSeconds === 'number' ? metaReadback.storeTtlSeconds : 'null'} sessionVersion=${typeof metaReadback?.sessionVersion === 'string' ? metaReadback.sessionVersion : 'null'}`
  );

  logResearchSession(
    `Stored eBay Research storage state to ${resolution.selected} (${storageStateBytes} bytes)`
  );

  return {
    backend: resolution.selected,
    stateKey: resolution.stateKey,
    metaKey: resolution.metaKey,
    bytes: storageStateBytes,
    updatedAt,
    expiresAt,
    ttlSeconds,
    storeTtlSeconds,
  };
}

async function deleteResearchSessionFromStore(marketplace: string): Promise<void> {
  const resolution = resolveResearchSessionStore(marketplace);
  if (!resolution.store) {
    return;
  }

  try {
    await resolution.store.deleteStorageState();
  } catch {
    // Ignore KV invalidation failures so auth diagnostics can still surface.
  }
}

async function deleteResearchLocalFallbackArtifacts(
  source: Extract<ResearchSessionSource, 'filesystem' | 'playwright_profile'>
): Promise<void> {
  const storageStatePath = toAbsolutePath(RESEARCH_STORAGE_STATE_PATH);
  const metaPath = toAbsolutePath(RESEARCH_STORAGE_STATE_META_PATH);

  try {
    await Promise.all([
      rm(storageStatePath, { force: true }),
      rm(metaPath, { force: true }),
      ...(source === 'playwright_profile'
        ? [rm(toAbsolutePath(RESEARCH_PROFILE_DIR), { force: true, recursive: true })]
        : []),
    ]);
  } catch {
    // Ignore local invalidation failures so auth diagnostics can still surface.
  }
}

async function deleteResolvedResearchSession(
  marketplace: string,
  source: ResearchSessionSource
): Promise<void> {
  await deleteResearchSessionFromStore(marketplace);

  if (source === 'filesystem' || source === 'playwright_profile') {
    await deleteResearchLocalFallbackArtifacts(source);
  }
}

async function deleteCanonicalResearchStorageStateFromStore(marketplace: string): Promise<void> {
  const resolution = resolveResearchSessionStore(marketplace);
  if (!resolution.store) {
    return;
  }

  try {
    await resolution.store.deleteStorageState();
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
    const contentType = getResponseHeader(response.headers, 'content-type');
    const antiBotDetection = detectEbayResearchAntiBotResponse(response.data, contentType);
    const responseBodyExcerpt = response.data.slice(0, 300);
    const cookieDomains = [...new Set(options.cookies.map((c) => c.domain))].slice(0, 5).join(',');
    const cookieNames = options.cookies
      .slice(0, 5)
      .map((c) => c.name)
      .join(',');
    const ok = response.status >= 200 && response.status < 300 && modulesSeen.length > 0;
    const result: ResearchSessionValidationResult = ok
      ? {
          ok: true,
          responseStatus: response.status,
          modulesSeen,
          antiBotDetection: antiBotDetection.detected ? antiBotDetection : undefined,
          note: `${options.sourceLabel} passed ACTIVE endpoint validation with ${modulesSeen.length} research modules.`,
        }
      : {
          ok: false,
          responseStatus: response.status,
          modulesSeen,
          antiBotDetection: antiBotDetection.detected ? antiBotDetection : undefined,
          note: antiBotDetection.detected
            ? `${options.sourceLabel} reached eBay Research but ${buildAntiBotNote(antiBotDetection)} modulesSeen=[${modulesSeen.join(',')}] cookieDomains=[${cookieDomains}] cookieNames=[${cookieNames}] responseBody="${responseBodyExcerpt}"`
            : response.status === 401 || response.status === 403
              ? `${options.sourceLabel} rejected HTTP ${response.status} modulesSeen=[${modulesSeen.join(',')}] cookieDomains=[${cookieDomains}] cookieNames=[${cookieNames}] responseBody="${responseBodyExcerpt}"`
              : `${options.sourceLabel} reached endpoint HTTP ${response.status} but no usable modules modulesSeen=[${modulesSeen.join(',')}] cookieDomains=[${cookieDomains}] cookieNames=[${cookieNames}] responseBody="${responseBodyExcerpt}"`,
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

  const normalized = value.replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const currencyMatch = /[$£€]\s*(-?\d+(?:\.\d+)?)/u.exec(normalized);
  if (currencyMatch?.[1]) {
    const parsed = Number(currencyMatch[1]);
    return Number.isFinite(parsed) ? round(parsed) : null;
  }

  if (/^free shipping$/iu.test(normalized)) {
    return 0;
  }

  return parseNumberLike(normalized.replace(/[$£€]/g, '').replace(/\+/g, ''));
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

function sumSoldRowTotals(rows: EbayResearchSoldRow[]): number | null {
  const rowTotals = rows
    .map((row) => row.totalSold)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (rowTotals.length === 0) {
    return null;
  }

  return rowTotals.reduce((sum, value) => sum + value, 0);
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
    totalActiveListings: parseNumberLike(
      findAggregateMetricText(module, ['Total active listings'])
    ),
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
    totalItemSalesUsd: parseCurrencyValue(
      findAggregateMetricText(module, ['Total item sales', 'Item sales', 'Total Sales'])
    ),
  };
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, body: string) => {
    const normalized = body.toLowerCase();
    if (normalized.startsWith('#x')) {
      const parsed = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
    }
    if (normalized.startsWith('#')) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
    }
    return HTML_ENTITY_MAP[normalized] ?? entity;
  });
}

function stripHtmlText(value: string): string {
  return decodeHtmlText(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
  )
    .replace(/\s+/gu, ' ')
    .trim();
}

function isEbayResearchResultsHtml(payload: string): boolean {
  return (
    /\bresearch-table-row\b/iu.test(payload) ||
    /\baggregate-metric\b/iu.test(payload) ||
    /\b(?:active|sold)-tab-content\b/iu.test(payload)
  );
}

function findHtmlElementEnd(source: string, startIndex: number, tagName: string): number | null {
  const tagPattern = new RegExp(`</?${escapeRegex(tagName)}\\b[^>]*>`, 'giu');
  tagPattern.lastIndex = startIndex;
  let depth = 0;

  for (;;) {
    const match = tagPattern.exec(source);
    if (!match) {
      return null;
    }

    const tag = match[0];
    const isClosing = tag.startsWith('</');
    const isSelfClosing = tag.endsWith('/>');
    if (isClosing) {
      depth -= 1;
      if (depth === 0) {
        return tagPattern.lastIndex;
      }
    } else if (!isSelfClosing) {
      depth += 1;
    }
  }
}

function extractHtmlBlocksByClass(
  source: string,
  className: string,
  tagName = '[a-z0-9-]+'
): string[] {
  const classPattern = new RegExp(
    `<(${tagName})\\b(?=[^>]*\\bclass=(["'])[^"']*${escapeRegex(className)}[^"']*\\2)[^>]*>`,
    'giu'
  );
  const blocks: string[] = [];
  const consumedStarts = new Set<number>();

  for (;;) {
    const match = classPattern.exec(source);
    if (!match) {
      break;
    }

    if (consumedStarts.has(match.index)) {
      continue;
    }
    consumedStarts.add(match.index);

    const matchedTag = match[1];
    if (!matchedTag) {
      continue;
    }

    const endIndex = findHtmlElementEnd(source, match.index, matchedTag);
    if (endIndex !== null) {
      blocks.push(source.slice(match.index, endIndex));
    }
  }

  return blocks;
}

function extractFirstHtmlAttribute(
  block: string,
  tagName: string,
  attributeName: string
): string | null {
  const pattern = new RegExp(
    `<${escapeRegex(tagName)}\\b[^>]*\\b${escapeRegex(attributeName)}=(["'])(.*?)\\1`,
    'isu'
  );
  const match = pattern.exec(block);
  return match?.[2] ? decodeHtmlText(match[2]) : null;
}

function getHtmlCellBlock(rowHtml: string, classNames: string[]): string | null {
  for (const className of classNames) {
    const block = extractHtmlBlocksByClass(rowHtml, className, 'td')[0];
    if (block) {
      return block;
    }
  }
  return null;
}

function getHtmlCellText(rowHtml: string, classNames: string[]): string | null {
  const block = getHtmlCellBlock(rowHtml, classNames);
  const text = block ? stripHtmlText(block) : '';
  return text.length > 0 ? text : null;
}

function getHtmlCellCurrencyText(rowHtml: string, classNames: string[]): string | null {
  const block = getHtmlCellBlock(rowHtml, classNames);
  if (!block) {
    return null;
  }

  const text = stripHtmlText(block);
  const currencyMatch = /[$£€]\s*-?\d[\d,]*(?:\.\d+)?/u.exec(text);
  return currencyMatch?.[0] ?? (text.length > 0 ? text : null);
}

function extractHtmlListingUrl(productCell: string): string | null {
  const href = extractFirstHtmlAttribute(productCell, 'a', 'href');
  return href && href.length > 0 ? href : null;
}

function extractHtmlItemId(url: string | null): string | null {
  if (!url) {
    return null;
  }

  const itemPathMatch = /\/itm\/(\d+)/u.exec(url);
  if (itemPathMatch?.[1]) {
    return itemPathMatch[1];
  }

  const itemQueryMatch = /[?&]itemId=(\d+)/u.exec(url);
  return itemQueryMatch?.[1] ?? null;
}

function extractHtmlListingTitle(productCell: string): string {
  const imageAlt = extractFirstHtmlAttribute(productCell, 'img', 'alt');
  if (imageAlt && imageAlt.trim().length > 0) {
    return imageAlt.trim();
  }

  const titleBlock = extractHtmlBlocksByClass(
    productCell,
    'research-table-row__product-info-name'
  )[0];
  const title = titleBlock ? stripHtmlText(titleBlock) : stripHtmlText(productCell);
  return title.length > 0 ? title : 'Untitled research listing';
}

function parseHtmlAggregateModule(
  html: string,
  moduleName: 'HtmlActiveAggregateModule' | 'HtmlSoldAggregateModule'
): ParsedResearchModule | null {
  const seenLabels = new Set<string>();
  const metrics = extractHtmlBlocksByClass(html, 'aggregate-metric', 'section')
    .map((block) => {
      const valueBlock = extractHtmlBlocksByClass(block, 'metric-value', 'div')[0] ?? '';
      const labelBlock = extractHtmlBlocksByClass(block, 'subtitle', 'span')[0] ?? '';
      const header = stripHtmlText(labelBlock);
      const value = stripHtmlText(valueBlock);
      return { header, value };
    })
    .filter((metric) => {
      if (metric.header.length === 0 || metric.value.length === 0) {
        return false;
      }
      const key = compactComparableText(metric.header);
      if (seenLabels.has(key)) {
        return false;
      }
      seenLabels.add(key);
      return true;
    });

  if (metrics.length === 0) {
    return null;
  }

  return {
    moduleName,
    raw: {
      _type: moduleName,
      metrics,
    },
  };
}

function parseHtmlSoldRowsModule(html: string): ParsedResearchModule | null {
  const results = extractHtmlBlocksByClass(html, 'research-table-row', 'tr')
    .map((rowHtml) => {
      const productCell = getHtmlCellBlock(rowHtml, ['research-table-row__product-info']);
      if (!productCell) {
        return null;
      }

      const url = extractHtmlListingUrl(productCell);
      return {
        listing: {
          title: {
            text: extractHtmlListingTitle(productCell),
            action: url ? { URL: url } : undefined,
          },
          itemId: { value: extractHtmlItemId(url) },
        },
        avgsalesprice: {
          avgsalesprice: getHtmlCellCurrencyText(rowHtml, ['research-table-row__avgSoldPrice']),
        },
        avgshipping: {
          avgshipping: getHtmlCellCurrencyText(rowHtml, ['research-table-row__avgShippingCost']),
        },
        itemssold: getHtmlCellText(rowHtml, ['research-table-row__totalSoldCount']),
        totalsales: getHtmlCellCurrencyText(rowHtml, ['research-table-row__totalSalesValue']),
        datelastsold: getHtmlCellText(rowHtml, ['research-table-row__dateLastSold']),
      };
    })
    .filter((row) => row !== null);

  if (results.length === 0) {
    return null;
  }

  return {
    moduleName: 'HtmlSoldSearchResultsModule',
    raw: {
      _type: 'HtmlSoldSearchResultsModule',
      results,
    },
  };
}

function parseHtmlActiveRowsModule(html: string): ParsedResearchModule | null {
  const results = extractHtmlBlocksByClass(html, 'research-table-row', 'tr')
    .map((rowHtml) => {
      const productCell = getHtmlCellBlock(rowHtml, ['research-table-row__product-info']);
      if (!productCell) {
        return null;
      }

      const url = extractHtmlListingUrl(productCell);
      return {
        listing: {
          title: {
            text: extractHtmlListingTitle(productCell),
            action: url ? { URL: url } : undefined,
          },
          itemId: { value: extractHtmlItemId(url) },
        },
        listingPrice: {
          listingPrice: getHtmlCellText(rowHtml, [
            'research-table-row__listingPrice',
            'research-table-row__price',
            'research-table-row__currentPrice',
          ]),
          listingShipping: getHtmlCellText(rowHtml, [
            'research-table-row__shippingCost',
            'research-table-row__shipping',
            'research-table-row__listingShipping',
          ]),
        },
        watchers: getHtmlCellText(rowHtml, [
          'research-table-row__watchers',
          'research-table-row__watchCount',
        ]),
        promoted: getHtmlCellText(rowHtml, [
          'research-table-row__promoted',
          'research-table-row__promotedListing',
        ]),
        startDate: getHtmlCellText(rowHtml, [
          'research-table-row__startDate',
          'research-table-row__dateStarted',
        ]),
      };
    })
    .filter((row) => row !== null);

  if (results.length === 0) {
    return null;
  }

  return {
    moduleName: 'HtmlActiveSearchResultsModule',
    raw: {
      _type: 'HtmlActiveSearchResultsModule',
      results,
    },
  };
}

function parseResearchHtmlModules(payload: string): ParsedResearchModule[] {
  if (!isEbayResearchResultsHtml(payload)) {
    return [];
  }

  const modules: (ParsedResearchModule | null)[] = [];
  for (const soldHtml of extractHtmlBlocksByClass(payload, 'sold-tab-content', 'div')) {
    modules.push(parseHtmlAggregateModule(soldHtml, 'HtmlSoldAggregateModule'));
    modules.push(parseHtmlSoldRowsModule(soldHtml));
  }

  for (const activeHtml of extractHtmlBlocksByClass(payload, 'active-tab-content', 'div')) {
    modules.push(parseHtmlAggregateModule(activeHtml, 'HtmlActiveAggregateModule'));
    modules.push(parseHtmlActiveRowsModule(activeHtml));
  }

  return modules.filter((module): module is ParsedResearchModule => module !== null);
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
  const htmlModules = parseResearchHtmlModules(payload);
  if (htmlModules.length > 0) {
    return {
      modules: htmlModules,
      modulesSeen: uniqueStrings(htmlModules.map((module) => module.moduleName)),
      moduleCount: htmlModules.length,
      parseErrors: [],
    };
  }

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

function detectEbayResearchAntiBotResponse(
  payload: string,
  contentType: string | null
): ResearchAntiBotDetection {
  const normalizedPayload = payload.toLowerCase();
  const matchedSignals: string[] = [];
  const title = /<title[^>]*>([^<]+)<\/title>/iu.exec(payload)?.[1]?.trim() ?? null;
  const normalizedContentType = contentType?.toLowerCase() ?? '';
  const looksLikeHtml =
    normalizedContentType.includes('text/html') ||
    /^\s*<!doctype\s+html|^\s*<html[\s>]/iu.test(payload);

  if (looksLikeHtml && isEbayResearchResultsHtml(payload)) {
    return {
      detected: false,
      kind: null,
      title,
      contentType,
      matchedSignals: [],
    };
  }

  if (/pardon\s+our\s+interruption/iu.test(payload)) {
    matchedSignals.push('pardon_our_interruption');
  }
  if (
    /something\s+about\s+your\s+browser\s+made\s+us\s+think\s+you\s+were\s+a\s+bot/iu.test(payload)
  ) {
    matchedSignals.push('browser_made_us_think_bot');
  }
  if (looksLikeHtml && /captcha|g-recaptcha|hcaptcha|arkose|funcaptcha|challenge/iu.test(payload)) {
    matchedSignals.push('captcha_or_challenge_marker');
  }
  if (looksLikeHtml && /akamai|_abck|bm_sz|bm-verify|bot-manager|sensor_data/iu.test(payload)) {
    matchedSignals.push('bot_manager_marker');
  }
  if (looksLikeHtml && matchedSignals.length === 0) {
    matchedSignals.push('html_instead_of_research_json');
  }

  const kind: ResearchAntiBotChallengeKind | null = matchedSignals.includes(
    'pardon_our_interruption'
  )
    ? 'ebay_pardon_interruption'
    : matchedSignals.includes('captcha_or_challenge_marker')
      ? 'captcha_challenge'
      : looksLikeHtml
        ? 'html_interstitial'
        : null;

  return {
    detected:
      kind !== null ||
      (looksLikeHtml && /bot|captcha|challenge|interruption/iu.test(normalizedPayload)),
    kind,
    title,
    contentType,
    matchedSignals: uniqueStrings(matchedSignals),
  };
}

function mergeAntiBotDetections(
  ...detections: (ResearchAntiBotDetection | undefined)[]
): ResearchAntiBotDetection | undefined {
  const detected = detections.filter(
    (entry): entry is ResearchAntiBotDetection => entry !== undefined && entry.detected
  );
  if (detected.length === 0) {
    return undefined;
  }

  const preferredKind =
    detected.find((entry) => entry.kind === 'ebay_pardon_interruption')?.kind ??
    detected.find((entry) => entry.kind === 'captcha_challenge')?.kind ??
    detected[0]?.kind ??
    null;

  return {
    detected: true,
    kind: preferredKind,
    title: detected.find((entry) => entry.title !== null)?.title ?? null,
    contentType: detected.find((entry) => entry.contentType !== null)?.contentType ?? null,
    matchedSignals: uniqueStrings(detected.flatMap((entry) => entry.matchedSignals)),
  };
}

function buildAntiBotNote(detection: ResearchAntiBotDetection): string {
  const title = detection.title ? ` title="${detection.title}"` : '';
  const contentType = detection.contentType ? ` contentType="${detection.contentType}"` : '';
  const signals = detection.matchedSignals.length
    ? ` signals=[${detection.matchedSignals.join(',')}]`
    : '';
  return `eBay Research anti-bot challenge detected (${detection.kind ?? 'unknown'}).${title}${contentType}${signals}`;
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
    antiBotDetection: options.fetchResult.antiBotDetection.detected
      ? options.fetchResult.antiBotDetection
      : undefined,
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

function buildResearchUiUrlFromEndpointUrl(endpointUrl: string): string {
  const endpoint = new URL(endpointUrl);
  const uiUrl = new URL('https://www.ebay.com/sh/research');
  for (const key of [
    'marketplace',
    'keywords',
    'dayRange',
    'endDate',
    'startDate',
    'categoryId',
    'offset',
    'limit',
    'tabName',
    'tz',
  ]) {
    const value = endpoint.searchParams.get(key);
    if (value !== null) {
      uiUrl.searchParams.set(key, value);
    }
  }
  return uiUrl.toString();
}

async function reinjectResearchQueryUrlWithPlaywright(
  requestUrl: string,
  authState: ResearchAuthState
): Promise<ResearchCookie[] | null> {
  if (!authState.storageState) {
    return null;
  }

  const playwrightModule = await loadPlaywrightModule();
  if (!playwrightModule?.chromium?.launch) {
    return null;
  }

  const browser = await playwrightModule.chromium.launch({
    headless: true,
    channel: getPlaywrightChromiumChannel(),
  });
  try {
    const context = await browser.newContext({
      storageState: authState.storageState ?? storageStateFromCookies(authState.cookies),
    });
    try {
      if (typeof context.newPage !== 'function') {
        return null;
      }
      const page = await context.newPage();
      await page.goto('https://www.ebay.com/', {
        waitUntil: 'domcontentloaded',
      });
      await page.goto(buildResearchUiUrlFromEndpointUrl(requestUrl), {
        waitUntil: 'domcontentloaded',
      });
      return normalizeResearchCookies(await context.cookies('https://www.ebay.com'));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function requestResearchTabEndpoint(
  requestUrl: string,
  cookieHeader: string
): Promise<{
  status: number;
  data: string;
  headers?: unknown;
}> {
  return await axios.get<string>(requestUrl, {
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
}

function buildResearchTabFetchResult(
  response: {
    status: number;
    data: string;
    headers?: unknown;
  },
  cacheKey: string
): ResearchTabFetchResult {
  const contentType = getResponseHeader(response.headers, 'content-type');
  const antiBotDetection = detectEbayResearchAntiBotResponse(response.data, contentType);
  const parsedPayload = parseResearchModules(response.data);
  const pageErrors = extractPageErrors(parsedPayload.modules);
  if (antiBotDetection.detected) {
    pageErrors.unshift(buildAntiBotNote(antiBotDetection));
  }
  return {
    modules: parsedPayload.modules,
    modulesSeen: parsedPayload.modulesSeen,
    moduleCount: parsedPayload.moduleCount,
    parseErrors: parsedPayload.parseErrors,
    pageErrors: uniqueStrings(pageErrors),
    antiBotDetection,
    responseStatus: response.status,
    contentType,
    cacheKey,
    cacheEligible: response.status >= 200 && response.status < 300 && !antiBotDetection.detected,
  };
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
  const storeResolution = resolveResearchSessionStore(marketplace);
  logResearchSession(`Selected session store: ${storeResolution.selected}`);
  const diagnostics: Pick<
    ResearchAuthState,
    | 'sessionSource'
    | 'sessionStoreConfigured'
    | 'sessionStoreSelected'
    | 'kvLoadAttempted'
    | 'kvLoadSucceeded'
    | 'cfKvLoadAttempted'
    | 'cfKvLoadSucceeded'
    | 'upstashLoadAttempted'
    | 'upstashLoadSucceeded'
    | 'kvStorageStateBytes'
    | 'storageStateBytes'
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
    sessionStoreConfigured: storeResolution.configured,
    sessionStoreSelected: storeResolution.selected,
    kvLoadAttempted: false,
    kvLoadSucceeded: false,
    cfKvLoadAttempted: false,
    cfKvLoadSucceeded: false,
    upstashLoadAttempted: false,
    upstashLoadSucceeded: false,
    kvStorageStateBytes: null,
    storageStateBytes: null,
    envLoadAttempted: false,
    envLoadSucceeded: false,
    filesystemLoadAttempted: false,
    filesystemLoadSucceeded: false,
    profileLoadAttempted: false,
    profileLoadSucceeded: false,
    authValidationAttempted: false,
    authValidationSucceeded: false,
  };

  if (isKvEbayResearchSessionStoreBackend(storeResolution.selected)) {
    diagnostics.kvLoadAttempted = true;
    if (storeResolution.selected === 'cloudflare_kv') {
      diagnostics.cfKvLoadAttempted = true;
    }
    if (storeResolution.selected === 'upstash-redis') {
      diagnostics.upstashLoadAttempted = true;
    }
  }

  if (storeResolution.store && isKvEbayResearchSessionStoreBackend(storeResolution.selected)) {
    logResearchSession(`Attempting to load storage state from ${storeResolution.selected}`);
    const kvStorageStateRecord = await readResearchStorageStateFromStore(storeResolution);
    if (kvStorageStateRecord) {
      diagnostics.kvStorageStateBytes = kvStorageStateRecord.bytes;
      diagnostics.storageStateBytes = kvStorageStateRecord.bytes;

      // ── Debug: log storage shape without exposing cookie values ──
      logResearchSession(
        `Storage shape debug: bytes=${kvStorageStateRecord.bytes} rawType=${typeof kvStorageStateRecord.raw} rawLength=${kvStorageStateRecord.raw.length} hasCookies=${Array.isArray(JSON.parse(kvStorageStateRecord.raw).cookies) ?? false} cookieCount=${(JSON.parse(kvStorageStateRecord.raw).cookies ?? []).length} hasOrigins=${Array.isArray(JSON.parse(kvStorageStateRecord.raw).origins) ?? false} updatedAt=${kvStorageStateRecord.updatedAt ?? 'null'} source=${kvStorageStateRecord.source ?? 'null'}`
      );

      if (kvStorageStateRecord.parsed) {
        const resolvedSession = await resolveStorageStateCookies(
          kvStorageStateRecord.parsed,
          `${storeResolution.selected} storage state`,
          notes
        );
        if (resolvedSession && resolvedSession.cookies.length > 0) {
          diagnostics.kvLoadSucceeded = true;
          if (storeResolution.selected === 'cloudflare_kv') {
            diagnostics.cfKvLoadSucceeded = true;
          }
          if (storeResolution.selected === 'upstash-redis') {
            diagnostics.upstashLoadSucceeded = true;
          }
          logResearchSession(
            `Storage state load succeeded (${kvStorageStateRecord.bytes} bytes, ${resolvedSession.cookies.length} eBay cookies after sanitization)`
          );
          diagnostics.authValidationAttempted = true;
          const validation = await validateResearchAuthState({
            marketplace,
            cookies: resolvedSession.cookies,
            sourceLabel: `${storeResolution.selected} storage state`,
          });
          diagnostics.authValidationSucceeded = validation.ok;
          notes.push(validation.note);
          if (validation.ok) {
            logResearchSession('Auth validation succeeded');
            // Reset degradation counter on success
            const existingDegradation = readDegradationState(kvStorageStateRecord.meta);
            if (existingDegradation) {
              const resetDegradation: ResearchSessionDegradationState = {
                consecutiveFailures: 0,
                lastFailureAt: '',
                lastFailurePath: 'auth_rejection',
                lastFailureDetail: 'Validation succeeded — degradation counter reset',
              };
              await updateDegradationMeta(
                storeResolution,
                resetDegradation,
                kvStorageStateRecord.meta
              );
            }
            const value: ResearchAuthState = {
              cookies: resolvedSession.cookies,
              storageState: resolvedSession.storageState,
              authState: 'loaded',
              sessionStrategy: 'storage_state',
              ...diagnostics,
              sessionSource: 'kv',
              notes: [
                ...notes,
                `Restored canonical eBay Research storage state from ${storeResolution.selected}${kvStorageStateRecord.updatedAt ? ` (updated ${kvStorageStateRecord.updatedAt})` : ''}.`,
              ],
            };
            researchAuthCache[marketplace] = {
              expiresAt: Date.now() + RESEARCH_COOKIE_CACHE_TTL_MS,
              value,
            };
            return value;
          }

          // ── Path A: Auth validation failed ──
          logResearchSession(
            `Auth validation failed: status=${validation.responseStatus ?? 'null'} modulesSeen=${validation.modulesSeen.length} note=${validation.note}`
          );

          if (isExplicitResearchAuthRejection(validation)) {
            const existingDegradation = readDegradationState(kvStorageStateRecord.meta);
            const newFailures = (existingDegradation?.consecutiveFailures ?? 0) + 1;
            const degradation: ResearchSessionDegradationState = {
              consecutiveFailures: newFailures,
              lastFailureAt: new Date().toISOString(),
              lastFailurePath: 'auth_rejection',
              lastFailureDetail: `HTTP ${validation.responseStatus}: ${validation.note}`,
            };
            await updateDegradationMeta(storeResolution, degradation, kvStorageStateRecord.meta);

            if (
              shouldSkipDeletion({
                ...(kvStorageStateRecord.meta ?? {}),
                __degradation: degradation,
              })
            ) {
              notes.push(
                `Auth rejection detected (failure #${newFailures}/${RESEARCH_SESSION_MAX_FAILURES_BEFORE_DELETE}). Session preserved — will delete after ${RESEARCH_SESSION_MAX_FAILURES_BEFORE_DELETE} consecutive rejections. Validation: HTTP ${validation.responseStatus}.`
              );
              logResearchSession(
                `SESSION DELETION SKIPPED: auth_rejection failure #${newFailures}/${RESEARCH_SESSION_MAX_FAILURES_BEFORE_DELETE}, status=${validation.responseStatus}, cooldown active=${degradation.lastFailureAt ? 'true' : 'false'}`
              );
            } else {
              logResearchSession(
                `SESSION DELETION: auth_rejection after ${newFailures} consecutive failures, status=${validation.responseStatus}, note=${validation.note}`
              );
              await deleteResearchSessionFromStore(marketplace);
              notes.push(
                `Deleted canonical eBay Research storage state from ${storeResolution.selected} after ${newFailures} consecutive auth rejections (HTTP ${validation.responseStatus}).`
              );
            }
          } else {
            notes.push(
              `Preserved canonical eBay Research storage state in ${storeResolution.selected} because validation did not return an explicit auth rejection (status=${validation.responseStatus ?? 'null'}, modulesSeen=${validation.modulesSeen.length}).`
            );
          }
        } else {
          // ── Path B: Storage exists but no cookies after sanitization ──
          const existingDegradation = readDegradationState(kvStorageStateRecord.meta);
          const newFailures = (existingDegradation?.consecutiveFailures ?? 0) + 1;
          const cookieDomainDebug = kvStorageStateRecord.parsed.cookies
            .slice(0, 5)
            .map((c: any) => `${c.name}@${c.domain ?? 'no-domain'}`)
            .join(', ');
          const degradation: ResearchSessionDegradationState = {
            consecutiveFailures: newFailures,
            lastFailureAt: new Date().toISOString(),
            lastFailurePath: 'no_cookies',
            lastFailureDetail: `Raw cookie count=${kvStorageStateRecord.parsed.cookies.length} sample=[${cookieDomainDebug}] sanitized=0`,
          };
          await updateDegradationMeta(storeResolution, degradation, kvStorageStateRecord.meta);

          if (
            shouldSkipDeletion({ ...(kvStorageStateRecord.meta ?? {}), __degradation: degradation })
          ) {
            notes.push(
              `No usable eBay cookies after sanitization (failure #${newFailures}/${RESEARCH_SESSION_MAX_FAILURES_BEFORE_DELETE}). Session preserved. Raw cookies=${kvStorageStateRecord.parsed.cookies.length} sample=[${cookieDomainDebug}].`
            );
            logResearchSession(
              `SESSION DELETION SKIPPED: no_cookies failure #${newFailures}, rawCookies=${kvStorageStateRecord.parsed.cookies.length}`
            );
          } else {
            logResearchSession(
              `SESSION DELETION: no_cookies after ${newFailures} failures, rawCookies=${kvStorageStateRecord.parsed.cookies.length}, sample=[${cookieDomainDebug}]`
            );
            await deleteCanonicalResearchStorageStateFromStore(marketplace);
            notes.push(
              `Deleted canonical eBay Research storage state from ${storeResolution.selected} because no usable cookies could be restored after ${newFailures} attempts. Raw cookies=${kvStorageStateRecord.parsed.cookies.length}.`
            );
          }
        }
      } else {
        // ── Path C: Storage can't be parsed as valid JSON ──
        const existingDegradation = readDegradationState(kvStorageStateRecord.meta);
        const newFailures = (existingDegradation?.consecutiveFailures ?? 0) + 1;
        const rawExcerpt = kvStorageStateRecord.raw.slice(0, 200);
        const degradation: ResearchSessionDegradationState = {
          consecutiveFailures: newFailures,
          lastFailureAt: new Date().toISOString(),
          lastFailurePath: 'parse_failure',
          lastFailureDetail: `Parse failed for ${kvStorageStateRecord.bytes}-byte value, excerpt: ${rawExcerpt}`,
        };
        await updateDegradationMeta(storeResolution, degradation, kvStorageStateRecord.meta);

        logResearchSession(
          `SESSION DELETION SKIPPED: parse_failure failure #${newFailures}, bytes=${kvStorageStateRecord.bytes}, rawType=${typeof kvStorageStateRecord.raw}`
        );

        notes.push(
          `Canonical eBay Research storage state in ${storeResolution.selected} could not be parsed as Playwright storage-state JSON (failure #${newFailures}). Raw bytes=${kvStorageStateRecord.bytes}. Excerpt: ${rawExcerpt}`
        );
        // NOTE: We do NOT delete on parse failure — the raw data might be valid but just structured differently.
        // Keeping it allows manual inspection and prevents data loss from transient serialization issues.
      }
    } else {
      logResearchSession(`No storage state found in ${storeResolution.selected}`);
      notes.push(
        `No canonical eBay Research storage state was found in ${storeResolution.selected}.`
      );
    }
  } else if (storeResolution.selected !== 'none') {
    notes.push(
      storeResolution.error
        ? `Selected eBay Research session store ${storeResolution.selected} is unavailable (${storeResolution.error}).`
        : `Selected eBay Research session store ${storeResolution.selected} could not be initialized.`
    );
  } else {
    notes.push('No eBay Research session store backend is configured.');
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
          diagnostics.storageStateBytes = Buffer.byteLength(envStorageStateRaw, 'utf8');
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
            await persistResearchSessionToStore({
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
          const storageState = storageStateFromCookies(cookies);
          diagnostics.storageStateBytes = Buffer.byteLength(JSON.stringify(storageState), 'utf8');
          const value: ResearchAuthState = {
            cookies,
            storageState,
            authState: 'loaded',
            sessionStrategy: 'env_cookies',
            ...diagnostics,
            sessionSource: 'env',
            notes,
          };
          await persistResearchSessionToStore({
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

  if (shouldAttemptFilesystemFallback(storeResolution.selected)) {
    if (storeResolution.selected !== 'filesystem' && storeResolution.selected !== 'none') {
      logResearchSession(`Falling back to filesystem after ${storeResolution.selected}`);
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
        diagnostics.storageStateBytes = Buffer.byteLength(JSON.stringify(storageState), 'utf8');
        diagnostics.authValidationAttempted = true;
        const validation = await validateResearchAuthState({
          marketplace,
          cookies: resolvedSession.cookies,
          sourceLabel: `storage state file at ${storageStatePath}`,
        });
        diagnostics.authValidationSucceeded = validation.ok;
        notes.push(validation.note);
        if (!validation.ok) {
          if (isExplicitResearchAuthRejection(validation)) {
            await deleteResearchLocalFallbackArtifacts('filesystem');
            notes.push(
              `Deleted invalid storage state file at ${storageStatePath} after explicit auth rejection.`
            );
          }
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
          await persistResearchSessionToStore({
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
      diagnostics.storageStateBytes = Buffer.byteLength(
        JSON.stringify(profileState.storageState),
        'utf8'
      );
      diagnostics.authValidationAttempted = true;
      const validation = await validateResearchAuthState({
        marketplace,
        cookies: profileState.cookies,
        sourceLabel: `Playwright profile at ${profileDir}`,
      });
      diagnostics.authValidationSucceeded = validation.ok;
      notes.push(validation.note);
      if (!validation.ok) {
        if (isExplicitResearchAuthRejection(validation)) {
          await deleteResearchLocalFallbackArtifacts('playwright_profile');
          notes.push(
            `Deleted invalid Playwright profile at ${profileDir} after explicit auth rejection.`
          );
        }
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
        await persistResearchSessionToStore({
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

  let response = await requestResearchTabEndpoint(requestUrl, cookieHeader);

  if (response.status === 401 || response.status === 403) {
    invalidateResearchAuthValidationCache(options.marketplace, authState.cookies);
    delete researchAuthCache[options.marketplace];
    await deleteResolvedResearchSession(options.marketplace, authState.sessionSource);
    throw new EbayResearchAuthError(
      `Authenticated eBay Research session was rejected with status ${response.status}.`
    );
  }

  let result = buildResearchTabFetchResult(response, cacheKey);
  if (
    result.antiBotDetection.detected &&
    authState.storageState &&
    authState.sessionStrategy !== 'env_cookies'
  ) {
    invalidateResearchAuthValidationCache(options.marketplace, authState.cookies);
    const refreshedCookies = await reinjectResearchQueryUrlWithPlaywright(requestUrl, authState);
    const refreshedCookieHeader = refreshedCookies ? buildCookieHeader(refreshedCookies) : '';
    if (refreshedCookies && refreshedCookieHeader) {
      authState.cookies = refreshedCookies;
      response = await requestResearchTabEndpoint(requestUrl, refreshedCookieHeader);
      result = buildResearchTabFetchResult(response, cacheKey);
    }
  }

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
      /(?:ResearchAggregateModule|HtmlActiveAggregateModule)/i.test(module.moduleName)
    )?.raw;
    const activeSearchResultsModule = activeResult.modules.find((module) =>
      /ActiveSearchResultsModule/i.test(module.moduleName)
    )?.raw;
    const soldAggregateModule = soldResult.modules.find((module) =>
      /(?:ResearchAggregateModule|HtmlSoldAggregateModule)/i.test(module.moduleName)
    )?.raw;
    const soldSearchResultsModule = soldResult.modules.find((module) =>
      /SearchResultsModule/i.test(module.moduleName)
    )?.raw;

    const activeAggregate = parseActiveAggregate(activeAggregateModule);
    const activeRows = parseActiveRows(activeSearchResultsModule);
    const watcherMetrics = buildWatcherMetrics(activeRows);
    const soldAggregate = parseSoldAggregate(soldAggregateModule);
    const soldRows = parseSoldRows(soldSearchResultsModule);
    const totalSold = soldAggregate.totalSold ?? sumSoldRowTotals(soldRows);
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
      totalSold,
      totalSellers: soldAggregate.totalSellers,
      totalItemSalesUsd: soldAggregate.totalItemSalesUsd,
    });
    const activeUsefulResponse = isUsefulActiveResearchPayload(activeAggregate, activeRows.length);
    const soldUsefulResponse = isUsefulSoldResearchPayload(soldAggregate, soldRows.length);
    const antiBotDetection = mergeAntiBotDetections(
      activeResult.antiBotDetection,
      soldResult.antiBotDetection
    );
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
        totalSold,
        soldRows,
      },
      debug: {
        query: normalizedQuery,
        activeEndpointUrl,
        soldEndpointUrl,
        fetchedAt,
        modulesSeen: uniqueStrings([...activeResult.modulesSeen, ...soldResult.modulesSeen]),
        pageErrors: uniqueStrings([...activeResult.pageErrors, ...soldResult.pageErrors]),
        antiBotDetection,
        activeParse,
        soldParse,
        usefulResponse: activeUsefulResponse || soldUsefulResponse,
        ...buildResearchAuthDebug(
          antiBotDetection
            ? {
                ...authState,
                authState: 'unavailable',
                notes: [...authState.notes, buildAntiBotNote(antiBotDetection)],
              }
            : authState
        ),
        notes: antiBotDetection
          ? [...authState.notes, buildAntiBotNote(antiBotDetection)]
          : [...authState.notes],
      },
    };

    if (!hasUsefulResearchPayload(response)) {
      if (antiBotDetection) {
        return response;
      }

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
          validationDebug: buildValidationDebug(error, authState),
          notes: [...authState.notes, error.message],
        } as any,
      };
    }

    throw error;
  }
}

export interface EbayResearchAuthInspection {
  authState: EbayResearchResponse['debug']['authState'];
  sessionStrategy: EbayResearchResponse['debug']['sessionStrategy'];
  sessionSource: EbayResearchResponse['debug']['sessionSource'];
  sessionStoreConfigured: EbayResearchResponse['debug']['sessionStoreConfigured'];
  sessionStoreSelected: EbayResearchResponse['debug']['sessionStoreSelected'];
  kvLoadAttempted: EbayResearchResponse['debug']['kvLoadAttempted'];
  kvLoadSucceeded: EbayResearchResponse['debug']['kvLoadSucceeded'];
  cfKvLoadAttempted: EbayResearchResponse['debug']['cfKvLoadAttempted'];
  cfKvLoadSucceeded: EbayResearchResponse['debug']['cfKvLoadSucceeded'];
  upstashLoadAttempted: EbayResearchResponse['debug']['upstashLoadAttempted'];
  upstashLoadSucceeded: EbayResearchResponse['debug']['upstashLoadSucceeded'];
  kvStorageStateBytes: EbayResearchResponse['debug']['kvStorageStateBytes'];
  storageStateBytes: EbayResearchResponse['debug']['storageStateBytes'];
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

  await persistResearchSessionToStore({
    marketplace,
    cookies,
    storageState: sanitizedStorageState,
    source,
    sessionSource: getSessionSourceForStoreBackend(
      resolveResearchSessionStore(marketplace).selected
    ),
    required: true,
  });
  clearEbayResearchAuthCache();
}

export interface EbayResearchSessionStoreValidationResult {
  backend: EbayResearchSessionStoreBackend;
  stateKey: string | null;
  metaKey: string | null;
  bytes: number;
  updatedAt: string;
  expiresAt: string | null;
  ttlSeconds: number;
  storeTtlSeconds: number;
  validation: {
    ok: boolean;
    responseStatus: number | null;
    modulesSeen: string[];
    note: string;
  };
  cookieCount: number;
}

export async function validateAndStoreEbayResearchSessionToKv(
  marketplace: string,
  storageState: ResearchStorageState,
  source: ResearchSessionStrategy = 'storage_state'
): Promise<EbayResearchSessionStoreValidationResult> {
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

  const validation = await validateResearchAuthState({
    marketplace,
    cookies,
    sourceLabel: 'provided eBay Research storage state',
  });
  if (!validation.ok) {
    throw new EbayResearchAuthError(
      `Provided eBay Research storage state failed ACTIVE endpoint validation: ${validation.note}`
    );
  }

  const persistence = await persistResearchSessionToStore({
    marketplace,
    cookies,
    storageState: sanitizedStorageState,
    source,
    sessionSource: getSessionSourceForStoreBackend(
      resolveResearchSessionStore(marketplace).selected
    ),
    required: true,
  });
  if (!persistence) {
    throw new EbayResearchAuthError('Provided eBay Research storage state could not be persisted.');
  }

  clearEbayResearchAuthCache();
  return {
    ...persistence,
    validation,
    cookieCount: cookies.length,
  };
}

export interface EbayResearchSessionPersistenceInspection {
  sessionStoreConfigured: EbayResearchSessionStoreBackend;
  sessionStoreSelected: EbayResearchSessionStoreBackend;
  sessionStoreConfiguredFrom: 'env' | 'legacy_token_store' | 'default';
  sessionStoreRawConfiguredValue: string | null;
  storeTargetConnection: string | null;
  storeCredentialsConfigured: boolean;
  storeCredentialFingerprint: string | null;
  researchEnvironment: string;
  storageStateKeyScope: 'base' | 'scoped';
  canonicalStateKey: string | null;
  canonicalMetaKey: string | null;
  storageStateExists: boolean;
  metadataExists: boolean;
  storageStateBytes: number;
  storageStateValid: boolean | null;
  freshCanonicalReadback: EbayResearchFreshStoreValueInspection;
  error: string | null;
}

export async function inspectEbayResearchSessionPersistence(
  marketplace: string
): Promise<EbayResearchSessionPersistenceInspection> {
  const resolution = resolveResearchSessionStore(marketplace);
  const target = getEbayResearchSessionStoreTargetSummary(resolution.selected);
  const scope = getEbayResearchSessionStoreScopeSummary(marketplace);
  const freshCanonicalReadback = await inspectFreshCanonicalStorageState(marketplace);
  if (!resolution.store) {
    return {
      sessionStoreConfigured: resolution.configured,
      sessionStoreSelected: resolution.selected,
      sessionStoreConfiguredFrom: resolution.configuredFrom,
      sessionStoreRawConfiguredValue: resolution.rawConfiguredValue,
      storeTargetConnection: target.connection,
      storeCredentialsConfigured: target.credentialsConfigured,
      storeCredentialFingerprint: target.credentialFingerprint,
      researchEnvironment: scope.environment,
      storageStateKeyScope: scope.stateKeyScope,
      canonicalStateKey: resolution.stateKey,
      canonicalMetaKey: resolution.metaKey,
      storageStateExists: false,
      metadataExists: false,
      storageStateBytes: 0,
      storageStateValid: null,
      freshCanonicalReadback,
      error: resolution.error,
    };
  }

  const [rawStorageState, meta] = await Promise.all([
    resolution.store.getStorageState(),
    resolution.store.getMeta(),
  ]);

  const canonicalStorageStateValid = getStoredStorageStateValidity(rawStorageState);

  return {
    sessionStoreConfigured: resolution.configured,
    sessionStoreSelected: resolution.selected,
    sessionStoreConfiguredFrom: resolution.configuredFrom,
    sessionStoreRawConfiguredValue: resolution.rawConfiguredValue,
    storeTargetConnection: target.connection,
    storeCredentialsConfigured: target.credentialsConfigured,
    storeCredentialFingerprint: target.credentialFingerprint,
    researchEnvironment: scope.environment,
    storageStateKeyScope: scope.stateKeyScope,
    canonicalStateKey: resolution.stateKey,
    canonicalMetaKey: resolution.metaKey,
    storageStateExists: typeof rawStorageState === 'string' && rawStorageState.length > 0,
    metadataExists: meta !== null,
    storageStateBytes:
      typeof rawStorageState === 'string' ? Buffer.byteLength(rawStorageState, 'utf8') : 0,
    storageStateValid: canonicalStorageStateValid,
    freshCanonicalReadback,
    error: resolution.error,
  };
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
