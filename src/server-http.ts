import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import axios from 'axios';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { EbaySellerApi } from '@/api/index.js';
import {
  getBaseUrl,
  getConfiguredEnvironment,
  getHostedOauthScopes,
  getEbayConfig,
  getOAuthAuthorizationUrl,
  getValidationRunnerUserId,
  validateCredentialsForEnvironment,
  ruNameToEnvironment,
  type EbayEnvironment,
} from '@/config/environment.js';
import { getVersion } from '@/utils/version.js';
import { serverLogger } from '@/utils/logger.js';
import { MultiUserAuthStore } from '@/auth/multi-user-store.js';
import {
  evaluateEbayResearchSessionExpiryCheck,
  getEbayResearchSessionAlertCallbackUrl,
  verifyQStashRequestSignature,
  type EbayResearchSessionExpiryCheckPayload,
} from '@/validation/providers/ebay-research-session-alerts.js';
import {
  validateAndStoreEbayResearchSessionToKv,
  type ResearchStorageState,
} from '@/validation/providers/ebay-research.js';
import { createFreshEbayResearchSessionStoreResolution } from '@/validation/providers/ebay-research-session-store.js';
import type {
  getToolDefinitions as GetToolDefinitionsFn,
  executeTool as ExecuteToolFn,
} from './tools/index.js';

const CONFIG = {
  host: process.env.MCP_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  oauthStartKey: process.env.OAUTH_START_KEY ?? '',
};

const authStore = new MultiUserAuthStore();
// Emit the concrete backend class so logs can never claim "memory" while
// actually using Cloudflare (or vice-versa).  This fires once on startup,
// after dotenv has already been loaded by the config/environment import.
console.log(`[auth-store] Active KV backend: ${authStore.backendName}`);

function getServerBaseUrl(): string {
  return CONFIG.publicBaseUrl || `http://localhost:${CONFIG.port}`;
}

function getExpectedOAuthCallbackUrl(serverUrl = getServerBaseUrl()): string {
  return `${serverUrl.replace(/\/+$/, '')}/oauth/callback`;
}

function getNoVncPasswordFilePath(): string {
  return process.env.NOVNC_PASSWORD_FILE?.trim() || '/tmp/novnc-vnc-password';
}

function readNoVncPassword(): string | null {
  const passwordPath = getNoVncPasswordFilePath();
  if (!existsSync(passwordPath)) {
    return null;
  }
  try {
    const password = readFileSync(passwordPath, 'utf8').trim();
    return password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

function getNoVncPublicUrl(): string {
  const explicitUrl = process.env.NOVNC_PUBLIC_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const serverBaseUrl = getServerBaseUrl();
  try {
    const parsed = new URL(serverBaseUrl);
    const publicHost =
      process.env.NOVNC_PUBLIC_HOST?.trim() ||
      // Coolify/Traefik only routes the app domain to port 3000. For the current
      // temporary noVNC sidecar, advertise the verified direct-IP endpoint
      // rather than https://ebay-mcp.thousandstory.fyi:6081, which browsers
      // cannot reach through the app-domain router.
      (parsed.hostname === 'ebay-mcp.thousandstory.fyi' ? '65.108.95.146' : '');
    if (publicHost) {
      parsed.hostname = publicHost;
      parsed.protocol = process.env.NOVNC_PUBLIC_PROTOCOL?.trim() || 'http:';
    }
    parsed.port = process.env.NOVNC_PUBLIC_PORT?.trim() || process.env.NOVNC_PORT?.trim() || '6081';
    parsed.pathname = '/vnc.html';
    parsed.search = '';
    parsed.searchParams.set('autoconnect', '1');
    parsed.searchParams.set('resize', 'scale');
    parsed.searchParams.set('reconnect', '1');
    return parsed.toString();
  } catch {
    return `http://localhost:${process.env.NOVNC_PORT?.trim() || '6081'}/vnc.html?autoconnect=1&resize=scale&reconnect=1`;
  }
}

function getResearchLiveStorageStatePath(): string {
  return (
    process.env.EBAY_RESEARCH_LIVE_STORAGE_STATE_PATH?.trim() ||
    '/tmp/ebay-research-live-storage-state.json'
  );
}

function getResearchLivePidPath(): string {
  return process.env.EBAY_RESEARCH_LIVE_PID_PATH?.trim() || '/tmp/ebay-research-live.pid';
}

function getValidationRunnerWebhookUrl(): string {
  return (
    process.env.VALIDATION_RUNNER_RECORD_WEBHOOK_URL?.trim() ||
    process.env.N8N_VALIDATION_RUNNER_RECORD_WEBHOOK_URL?.trim() ||
    process.env.VALIDATION_RUNNER_WEBHOOK_URL?.trim() ||
    process.env.N8N_VALIDATION_RUNNER_WEBHOOK_URL?.trim() ||
    'https://n8n-n9t0lck7ziudk0uscztz4bfj.thousandstory.fyi/webhook/manual-data-runner-record'
  );
}

type AirtableFields = Record<string, unknown>;

interface AirtableRecord {
  id: string;
  createdTime?: string;
  fields?: AirtableFields;
}

interface ValidationRecordOption {
  recordId: string;
  item: string;
  label: string;
  searchQuery: string | null;
  directSearchQuery: string | null;
  lastAutoCheck: string | null;
  trackingCadence: string | null;
}

const AIRTABLE_DEFAULT_BASE_ID = 'appKrPI1uFI57Jppg';
const AIRTABLE_DEFAULT_VALIDATION_TABLE_ID = 'tblrdwYTgTYThU6x1';
const AIRTABLE_DEFAULT_ITEM_TABLE_ID = 'tblFwj5cEYvQ8h9kE';
const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

const AIRTABLE_VALIDATION_LIST_FIELDS = [
  'Item',
  'Resolved Search Query',
  'Direct Search Query',
  'Last Auto Check',
  'Tracking Cadence',
] as const;

const AIRTABLE_VALIDATION_TRANSFER_FIELDS = [
  'Active Avg. Price (USD)',
  'Active Listings Count',
  'Active Avg. Shipping (USD)',
  'Active Avg. Watchers per Listing',
  'Active Listing Price Min (USD)',
  'Active Listing Price Max (USD)',
  'Active Free Shipping %',
  'Active Promoted Listings %',
  'Active Watcher Coverage Count',
  'Sold Avg. Price (USD)',
  'Sold Median Price (USD)',
  'Sold Listings Count',
  'Sold Sell-Through %',
  'Sold Total Revenue (USD)',
  'Sold Avg. Shipping (USD)',
  'Sold Price Min (USD)',
  'Sold Price Max (USD)',
  'Sold Free Shipping %',
  'Sold Total Sellers',
  'Day 1 Sold',
  'Day 2 Sold',
  'Day 3 Sold',
  'Day 4 Sold',
  'Day 5 Sold',
  'Days Tracked',
  'Last Auto Check',
  'Last Data Snapshot',
] as const;

function getAirtableApiKey(): string {
  return process.env.AIRTABLE_API_KEY?.trim() || process.env.AIRTABLE_PAT?.trim() || '';
}

function getAirtableBaseId(): string {
  return (
    process.env.VALIDATION_AIRTABLE_BASE_ID?.trim() ||
    process.env.AIRTABLE_BASE_ID?.trim() ||
    AIRTABLE_DEFAULT_BASE_ID
  );
}

function getAirtableValidationTableId(): string {
  return (
    process.env.VALIDATION_AIRTABLE_TABLE_ID?.trim() ||
    process.env.AIRTABLE_VALIDATION_TABLE_ID?.trim() ||
    AIRTABLE_DEFAULT_VALIDATION_TABLE_ID
  );
}

function getAirtableItemTableId(): string {
  return (
    process.env.VALIDATION_AIRTABLE_ITEM_TABLE_ID?.trim() ||
    process.env.AIRTABLE_ITEM_TABLE_ID?.trim() ||
    AIRTABLE_DEFAULT_ITEM_TABLE_ID
  );
}

function getAirtableAuthHeaders(): Record<string, string> {
  const apiKey = getAirtableApiKey();
  if (!apiKey) {
    throw new Error('AIRTABLE_API_KEY_MISSING');
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function getAirtableTableUrl(tableId: string, params?: URLSearchParams): string {
  const encodedTableId = encodeURIComponent(tableId);
  const query = params?.toString();
  return `${AIRTABLE_API_BASE}/${getAirtableBaseId()}/${encodedTableId}${query ? `?${query}` : ''}`;
}

function appendAirtableFields(params: URLSearchParams, fields: readonly string[]): void {
  for (const field of fields) {
    params.append('fields[]', field);
  }
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(coerceString).filter(Boolean).join(', ');
  return '';
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(coerceString)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getField(fields: AirtableFields | undefined, fieldName: string): unknown {
  return fields && Object.prototype.hasOwnProperty.call(fields, fieldName)
    ? fields[fieldName]
    : null;
}

function normalizeForCompare(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function metricGroup(fieldName: string): 'active' | 'sold' | 'velocity' | 'meta' {
  if (fieldName.startsWith('Active ')) return 'active';
  if (fieldName.startsWith('Sold ')) return 'sold';
  if (fieldName.startsWith('Day ') || fieldName === 'Days Tracked') return 'velocity';
  return 'meta';
}

async function fetchAirtableRecords(
  tableId: string,
  fields: readonly string[],
  options: { filterByFormula?: string; maxRecords?: number } = {}
): Promise<AirtableRecord[]> {
  const params = new URLSearchParams();
  params.set('pageSize', '100');
  if (options.maxRecords) params.set('maxRecords', String(options.maxRecords));
  if (options.filterByFormula) params.set('filterByFormula', options.filterByFormula);
  appendAirtableFields(params, fields);

  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    if (offset) params.set('offset', offset);
    const response = await axios.get<{ records: AirtableRecord[]; offset?: string }>(
      getAirtableTableUrl(tableId, params),
      { headers: getAirtableAuthHeaders(), timeout: 30_000 }
    );
    records.push(...(response.data.records ?? []));
    offset = response.data.offset;
  } while (offset && (!options.maxRecords || records.length < options.maxRecords));

  return options.maxRecords ? records.slice(0, options.maxRecords) : records;
}

async function fetchAirtableItemNames(itemRecordIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(itemRecordIds.filter((id) => /^rec[A-Za-z0-9]+$/.test(id)))];
  const names = new Map<string, string>();
  for (let i = 0; i < uniqueIds.length; i += 25) {
    const chunk = uniqueIds.slice(i, i + 25);
    const formula = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
    const records = await fetchAirtableRecords(getAirtableItemTableId(), ['Item'], {
      filterByFormula: formula,
      maxRecords: chunk.length,
    });
    for (const record of records) {
      const itemName = coerceString(getField(record.fields, 'Item')).trim();
      if (itemName) names.set(record.id, itemName);
    }
  }
  return names;
}

function extractSnapshotSummary(
  fields: AirtableFields | undefined
): Record<string, unknown> | null {
  const rawSnapshot = getField(fields, 'Last Data Snapshot');
  if (typeof rawSnapshot !== 'string' || !rawSnapshot.trim()) return null;
  try {
    const parsed = JSON.parse(rawSnapshot) as Record<string, unknown>;
    const effectiveContext = (parsed.effectiveContext ?? {}) as Record<string, unknown>;
    const ebay = (parsed.ebay ?? {}) as Record<string, unknown>;
    const sold = (parsed.sold ?? {}) as Record<string, unknown>;
    const terapeak = (parsed.terapeak ?? {}) as Record<string, unknown>;
    const queryDebug = (terapeak.queryDebug ?? {}) as Record<string, unknown>;
    const antiBotDetection = (queryDebug.antiBotDetection ?? null) as Record<
      string,
      unknown
    > | null;
    const fallbackReasons = Array.isArray(queryDebug.fallbackReasons)
      ? queryDebug.fallbackReasons.filter((value): value is string => typeof value === 'string')
      : [];
    const currentPageErrors = Array.isArray(queryDebug.currentPageErrors)
      ? queryDebug.currentPageErrors.filter((value): value is string => typeof value === 'string')
      : [];
    const notes = typeof queryDebug.notes === 'string' ? queryDebug.notes : null;
    const terapeakFailureReason =
      currentPageErrors[0] ??
      fallbackReasons.find((reason) => !reason.includes('Hydrated ')) ??
      notes ??
      null;
    const soldFallbackUsed =
      (terapeak.soldListingsCount === null || terapeak.soldListingsCount === undefined) &&
      sold.provider !== null &&
      sold.provider !== undefined;
    return {
      itemName: effectiveContext.itemName ?? null,
      effectiveSearchQuery: effectiveContext.effectiveSearchQuery ?? null,
      validationScope: effectiveContext.validationScope ?? null,
      queryScope: effectiveContext.queryScope ?? null,
      activeSource:
        terapeak.activeListingsCount !== null && terapeak.activeListingsCount !== undefined
          ? 'ebay_research_ui'
          : 'ebay_browse',
      soldSource:
        terapeak.soldListingsCount !== null && terapeak.soldListingsCount !== undefined
          ? 'ebay_research_ui'
          : (sold.provider ?? 'none'),
      soldFallbackUsed,
      terapeakProvider: terapeak.provider ?? null,
      terapeakConfidence: terapeak.confidence ?? null,
      terapeakActiveListingsCount: terapeak.activeListingsCount ?? null,
      terapeakSoldListingsCount: terapeak.soldListingsCount ?? null,
      terapeakFailureReason,
      terapeakAntiBotDetection: antiBotDetection,
      terapeakAuthState: queryDebug.authState ?? null,
      terapeakSessionSource: queryDebug.sessionSource ?? null,
      thirdPartySoldStatus: sold.status ?? null,
      ebayActiveListingsCount: ebay.preOrderListingsCount ?? ebay.competitionLevel ?? null,
    };
  } catch {
    return { parseStatus: 'failed' };
  }
}

async function fetchValidationRecordFields(recordId: string): Promise<AirtableFields | null> {
  const records = await fetchAirtableRecords(
    getAirtableValidationTableId(),
    AIRTABLE_VALIDATION_TRANSFER_FIELDS,
    { filterByFormula: `RECORD_ID()='${recordId}'`, maxRecords: 1 }
  );
  return records[0]?.fields ?? null;
}

function buildValidationTransferSummary(
  recordId: string,
  beforeFields: AirtableFields | null,
  afterFields: AirtableFields | null,
  webhookStatus: number
): Record<string, unknown> {
  const fields = AIRTABLE_VALIDATION_TRANSFER_FIELDS.map((fieldName) => {
    const before = getField(beforeFields ?? undefined, fieldName);
    const after = getField(afterFields ?? undefined, fieldName);
    return {
      field: fieldName,
      group: metricGroup(fieldName),
      before,
      after,
      changed: normalizeForCompare(before) !== normalizeForCompare(after),
    };
  });
  const changedFields = fields.filter((field) => field.changed).map((field) => field.field);
  return {
    recordId,
    webhookStatus,
    changedFieldCount: changedFields.length,
    changedFields,
    fields,
    snapshotSummary: extractSnapshotSummary(afterFields ?? undefined),
  };
}

async function listValidationRecordOptions(
  query: string,
  limit: number
): Promise<ValidationRecordOption[]> {
  const records = await fetchAirtableRecords(
    getAirtableValidationTableId(),
    AIRTABLE_VALIDATION_LIST_FIELDS,
    { maxRecords: Math.min(Math.max(limit * 4, 100), 500) }
  );
  const linkedItemIds = records.flatMap((record) =>
    coerceStringArray(getField(record.fields, 'Item'))
  );
  const itemNames = await fetchAirtableItemNames(linkedItemIds);
  const normalizedQuery = query.trim().toLowerCase();

  return records
    .map((record) => {
      const itemIds = coerceStringArray(getField(record.fields, 'Item'));
      const item = itemIds.map((id) => itemNames.get(id) ?? id).join(', ') || '(no linked item)';
      const searchQuery = coerceString(getField(record.fields, 'Resolved Search Query')).trim();
      const directSearchQuery = coerceString(getField(record.fields, 'Direct Search Query')).trim();
      const label = `${record.id} - ${item}`;
      return {
        recordId: record.id,
        item,
        label,
        searchQuery: searchQuery || null,
        directSearchQuery: directSearchQuery || null,
        lastAutoCheck: coerceString(getField(record.fields, 'Last Auto Check')).trim() || null,
        trackingCadence: coerceString(getField(record.fields, 'Tracking Cadence')).trim() || null,
      };
    })
    .filter((option) => {
      if (!normalizedQuery) return true;
      return [option.label, option.searchQuery, option.directSearchQuery]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    })
    .slice(0, limit);
}

function getResearchLiveStatus(): {
  enabled: boolean;
  display: string;
  noVncUrl: string;
  noVncPassword: string | null;
  noVncPasswordFile: string;
  storageStatePath: string;
  storageStateExists: boolean;
  livePid: number | null;
  livePidFile: string;
} {
  const pidPath = getResearchLivePidPath();
  let livePid: number | null = null;
  if (existsSync(pidPath)) {
    const rawPid = readFileSync(pidPath, 'utf8').trim();
    const parsedPid = Number(rawPid);
    if (Number.isInteger(parsedPid) && parsedPid > 0) {
      livePid = parsedPid;
    }
  }

  const storageStatePath = getResearchLiveStorageStatePath();
  const noVncPassword = readNoVncPassword();
  const noVncEnvEnabled = ['1', 'true', 'yes'].includes(
    (process.env.ENABLE_NOVNC ?? '').toLowerCase()
  );
  return {
    enabled: noVncEnvEnabled || noVncPassword !== null,
    display: process.env.DISPLAY || `:${process.env.NOVNC_DISPLAY || '99'}`,
    noVncUrl: getNoVncPublicUrl(),
    noVncPassword,
    noVncPasswordFile: getNoVncPasswordFilePath(),
    storageStatePath,
    storageStateExists: existsSync(storageStatePath),
    livePid,
    livePidFile: pidPath,
  };
}

function getEbayOAuthRedirectUri(ebayConfig: ReturnType<typeof getEbayConfig>): string | undefined {
  return ebayConfig.ruName || ebayConfig.redirectUri;
}

function isLocalDevelopmentBaseUrl(baseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const { hostname } = new URL(baseUrl);
    const normalizedHost = hostname.toLowerCase();

    return (
      normalizedHost === 'localhost' ||
      normalizedHost === '127.0.0.1' ||
      normalizedHost === '::1' ||
      normalizedHost === 'ebay-local.test' ||
      normalizedHost.endsWith('.localhost') ||
      normalizedHost.endsWith('.test')
    );
  } catch {
    return false;
  }
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

function getValidationIdFromBody(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'validationId' in body &&
    typeof body.validationId === 'string'
  ) {
    return body.validationId;
  }
  return '';
}

function getValidationRecordIdFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }

  const maybeBody = body as { recordId?: unknown; validationId?: unknown };
  const rawRecordId =
    typeof maybeBody.recordId === 'string'
      ? maybeBody.recordId
      : typeof maybeBody.validationId === 'string'
        ? maybeBody.validationId
        : '';
  return rawRecordId.trim();
}

function getRetryTimestampFromBody(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'timestamp' in body &&
    typeof body.timestamp === 'string'
  ) {
    const parsed = new Date(body.timestamp);
    if (Number.isFinite(parsed.getTime())) {
      return new Date(parsed.getTime() + 30 * 60 * 1000).toISOString();
    }
  }
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

function getSingleHeader(req: express.Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthyHeader(value: string): boolean {
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function getAxiosFailureDebug(error: unknown): {
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
} {
  if (!axios.isAxiosError(error)) {
    return {
      responseStatus: null,
      responseBodyExcerpt: null,
    };
  }

  const responseStatus = error.response?.status ?? null;
  const rawBody: unknown = error.response?.data;

  if (rawBody === undefined) {
    return {
      responseStatus,
      responseBodyExcerpt: null,
    };
  }

  const bodyText = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2);

  return {
    responseStatus,
    responseBodyExcerpt: bodyText.slice(0, 500),
  };
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!CONFIG.adminApiKey) {
    res.status(500).json({ error: 'ADMIN_API_KEY is not configured' });
    return;
  }
  const header = req.headers['x-admin-api-key'];
  const queryKey = typeof req.query.key === 'string' ? req.query.key : undefined;
  if (header !== CONFIG.adminApiKey && queryKey !== CONFIG.adminApiKey) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function requireOauthStartKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!CONFIG.oauthStartKey) {
    next();
    return;
  }
  const header = req.headers['x-oauth-start-key'];
  const queryKey = typeof req.query.key === 'string' ? req.query.key : '';
  if (header !== CONFIG.oauthStartKey && queryKey !== CONFIG.oauthStartKey) {
    res.status(401).json({ error: 'unauthorized_oauth_start' });
    return;
  }
  next();
}

/**
 * Returns true when a redirect URI belongs to a well-known desktop / IDE
 * MCP client (VS Code, Cursor, Windsurf) or a localhost loopback.
 */
function isTrustedDesktopRedirectUri(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (
      u.protocol === 'vscode:' ||
      u.protocol === 'cursor:' ||
      u.protocol === 'windsurf:' ||
      u.protocol === 'claude:'
    ) {
      return true;
    }
    if (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1')
    ) {
      return true;
    }
  } catch {
    // Malformed URI – treat as untrusted
  }
  return false;
}

async function createUserScopedApi(
  userId: string,
  environment: EbayEnvironment
): Promise<EbaySellerApi> {
  const api = new EbaySellerApi(getEbayConfig(environment), { userId, environment });
  await api.initialize();
  return api;
}

// ── Shared MCP transport map (keyed by MCP session UUID) ─────────────────
// A single map is safe — session IDs are UUIDs with no env-specific uniqueness
// requirement.
const transports = new Map<string, StreamableHTTPServerTransport>();

export function createApp(): express.Application {
  const app = express();
  app.disable('x-powered-by');
  const currentFilename = fileURLToPath(import.meta.url);
  const currentDirname = dirname(currentFilename);
  const projectRoot = join(currentDirname, '..');
  type RequestWithRawBody = express.Request & { rawBody?: string };

  app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'] }));
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString('utf8');
      },
    })
  );
  // OAuth token endpoint sends application/x-www-form-urlencoded per RFC 6749
  app.use(
    express.urlencoded({
      extended: false,
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(helmet({ xPoweredBy: false }));
  app.use('/icons', express.static(join(projectRoot, 'public', 'icons')));
  app.use('/callback-copy.js', express.static(join(projectRoot, 'public', 'callback-copy.js')));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const message = `${req.method} ${req.path} -> ${res.statusCode}`;
      const meta = {
        durationMs: Date.now() - start,
      };

      if (req.path === '/health' || req.path.endsWith('/validation/health')) {
        serverLogger.verbose(message, meta);
        return;
      }

      serverLogger.info(message, meta);
    });
    next();
  });

  const serverUrl = getServerBaseUrl();
  const iconBaseUrl = `${serverUrl}/icons`;

  // ── RFC 9728 – Path-based Protected Resource Metadata ────────────────────
  // Cline probes these URLs for MCP resources at /sandbox/mcp and /production/mcp.
  // RFC 9728 §3 defines the well-known URI as:
  //   /.well-known/oauth-protected-resource{path-to-resource}
  // We must serve these before the env routers so they are not caught by their
  // own /.well-known/... handler (which is relative to the router base path).

  app.get('/.well-known/oauth-protected-resource/sandbox/mcp', (_req, res) => {
    res.json({
      resource: `${serverUrl}/sandbox/mcp`,
      authorization_servers: [`${serverUrl}/sandbox`],
      scopes_supported: ['mcp'],
      resource_documentation: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
    });
  });

  app.get('/.well-known/oauth-protected-resource/production/mcp', (_req, res) => {
    res.json({
      resource: `${serverUrl}/production/mcp`,
      authorization_servers: [`${serverUrl}/production`],
      scopes_supported: ['mcp'],
      resource_documentation: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
    });
  });

  // Generic fallback: serves the default-env resource metadata.
  // Also satisfies clients that probe /.well-known/oauth-protected-resource
  // without a path suffix.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    const defaultEnv = getConfiguredEnvironment();
    res.json({
      resource: `${serverUrl}/${defaultEnv}/mcp`,
      authorization_servers: [`${serverUrl}/${defaultEnv}`],
      scopes_supported: ['mcp'],
      resource_documentation: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
    });
  });

  // ── RFC 8414 §3 – Path-based Authorization Server Metadata ───────────────
  // When Protected Resource Metadata says authorization_servers: ["…/sandbox"],
  // RFC 8414 §3 requires the auth server metadata to be fetchable at:
  //   /.well-known/oauth-authorization-server/sandbox   (NOT /sandbox/.well-known/…)
  //
  // Cline probes exactly this form. Without these routes it falls back to root
  // /authorize which silently defaults to production.

  app.get('/.well-known/oauth-authorization-server/sandbox', (_req, res) => {
    const base = `${serverUrl}/sandbox`;
    // authorization_endpoint uses the ROOT /authorize with ?env=sandbox so that
    // MCP clients (like Cline) that strip the path prefix from the issuer URL
    // still land on the correct environment — the ?env= query param is
    // preserved through URL construction and picked up by resolveEnv().
    // token/registration still use the env-scoped path.
    res.json({
      issuer: base,
      authorization_endpoint: `${serverUrl}/authorize?env=sandbox`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  app.get('/.well-known/oauth-authorization-server/production', (_req, res) => {
    const base = `${serverUrl}/production`;
    res.json({
      issuer: base,
      authorization_endpoint: `${serverUrl}/authorize?env=production`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // ── Root index / health ───────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.json({
      name: 'ebay-mcp-remote-edition',
      version: getVersion(),
      mode: 'multi-user-hosted',
      description:
        'Hosted MCP + OAuth server for eBay APIs, including validation routes and internal eBay Research session-expiry alert callbacks.',
      mcp_endpoints: {
        sandbox: `${serverUrl}/sandbox/mcp`,
        production: `${serverUrl}/production/mcp`,
        default: `${serverUrl}/mcp`,
      },
      oauth_start: {
        sandbox: `${serverUrl}/sandbox/oauth/start`,
        production: `${serverUrl}/production/oauth/start`,
      },
      validation_endpoints: {
        run: `${serverUrl}/validation/run`,
      },
      internal_endpoints: {
        ebayResearchSessionExpiryCheck: `${serverUrl}/internal/ebay-research/check-session-expiry`,
      },
    });
  });

  app.get('/health', (req, res) => {
    const healthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: getVersion(),
    };

    serverLogger.verbose('Health response emitted', {
      path: req.originalUrl,
      status: healthResponse.status,
      timestamp: healthResponse.timestamp,
      version: healthResponse.version,
    });

    res.json(healthResponse);
  });

  app.post('/internal/ebay-research/check-session-expiry', async (req, res) => {
    const rawBody =
      (req as RequestWithRawBody).rawBody ??
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    const signatureHeader = req.headers['upstash-signature'];
    const signature = typeof signatureHeader === 'string' ? signatureHeader : null;
    const expectedUrl = getEbayResearchSessionAlertCallbackUrl();

    try {
      verifyQStashRequestSignature({
        signature,
        rawBody,
        url: expectedUrl,
      });
    } catch (error) {
      serverLogger.warn('[eBayResearchSessionAlerts] Rejected callback with invalid signature', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(401).json({
        status: 'error',
        message: 'invalid qstash signature',
      });
      return;
    }

    const payload = req.body as EbayResearchSessionExpiryCheckPayload;

    try {
      const result = await evaluateEbayResearchSessionExpiryCheck(payload);
      res.status(result.status === 'error' ? 500 : 200).json(result);
    } catch (error) {
      serverLogger.error('[eBayResearchSessionAlerts] Callback evaluation failed', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });
      res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Admin routes ──────────────────────────────────────────────────────────

  app.get('/admin/session/:sessionToken', requireAdmin, async (req, res) => {
    const tokenParam = req.params.sessionToken;
    const sessionToken = typeof tokenParam === 'string' ? tokenParam : tokenParam[0];
    const session = await authStore.getSession(sessionToken);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(session);
  });

  app.get('/whoami', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_session_token' });
      return;
    }
    const sessionToken = authHeader.slice('Bearer '.length).trim();
    const session = await authStore.getSession(sessionToken);
    if (!session || session.revokedAt) {
      res.status(401).json({ error: 'invalid_session_token' });
      return;
    }
    res.json({
      userId: session.userId,
      environment: session.environment,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastUsedAt: session.lastUsedAt,
      revokedAt: session.revokedAt ?? null,
    });
  });

  app.post('/admin/session/:sessionToken/revoke', requireAdmin, async (req, res) => {
    const tokenParam = req.params.sessionToken;
    const sessionToken = typeof tokenParam === 'string' ? tokenParam : tokenParam[0];
    await authStore.revokeSession(sessionToken);
    res.json({ ok: true, revoked: true });
  });

  app.delete('/admin/session/:sessionToken', requireAdmin, async (req, res) => {
    const tokenParam = req.params.sessionToken;
    const sessionToken = typeof tokenParam === 'string' ? tokenParam : tokenParam[0];
    await authStore.deleteSession(sessionToken);
    res.json({ ok: true, deleted: true });
  });

  // ── Admin: Token & Session Status ──────────────────────────────────────────

  app.get('/admin/token-status', requireAdmin, async (req, res) => {
    const environment: EbayEnvironment = 'production';
    const validationRunnerUserId = getValidationRunnerUserId(environment);
    if (!validationRunnerUserId) {
      res.status(500).json({
        status: 'error',
        message: 'Validation runner user ID not configured for production',
        environment,
      });
      return;
    }

    const storedTokens = await authStore.getUserTokens(validationRunnerUserId, environment);
    const now = Date.now();

    const oauthStatus: {
      status: 'ok' | 'missing' | 'access_expired' | 'refresh_expired';
      userId: string;
      accessTokenExpiry?: string | null;
      refreshTokenExpiry?: string | null;
      accessTokenRemainingMs?: number | null;
      refreshTokenRemainingMs?: number | null;
      scope?: string | null;
    } = {
      status: 'missing',
      userId: validationRunnerUserId,
      accessTokenExpiry: null,
      refreshTokenExpiry: null,
      accessTokenRemainingMs: null,
      refreshTokenRemainingMs: null,
      scope: null,
    };

    if (storedTokens?.tokenData) {
      const td = storedTokens.tokenData;
      const accessExp = td.userAccessTokenExpiry ?? 0;
      const refreshExp = td.userRefreshTokenExpiry ?? 0;
      const accessRem = Math.max(0, accessExp - now);
      const refreshRem = Math.max(0, refreshExp - now);

      if (refreshRem <= 0) {
        oauthStatus.status = 'refresh_expired';
      } else if (accessRem <= 0) {
        oauthStatus.status = 'access_expired';
      } else {
        oauthStatus.status = 'ok';
      }
      oauthStatus.accessTokenExpiry = accessExp > 0 ? new Date(accessExp).toISOString() : null;
      oauthStatus.refreshTokenExpiry = refreshExp > 0 ? new Date(refreshExp).toISOString() : null;
      oauthStatus.accessTokenRemainingMs = accessRem;
      oauthStatus.refreshTokenRemainingMs = refreshRem;
      oauthStatus.scope = td.scope ?? null;
    }

    // Playwright session status
    const store = createFreshEbayResearchSessionStoreResolution('EBAY-US');
    const sessionStatus: {
      status: 'ok' | 'missing' | 'expired';
      backend: string;
      storageStateKey: string | null;
      metadataKey: string | null;
      storageStateBytes?: number | null;
      expiresAt?: string | null;
      sessionVersion?: string | null;
      updatedAt?: string | null;
    } = {
      status: 'missing',
      backend: store.selected,
      storageStateKey: store.stateKey,
      metadataKey: store.metaKey,
      storageStateBytes: null,
      expiresAt: null,
      sessionVersion: null,
      updatedAt: null,
    };

    if (store.store) {
      const meta = await store.store.getMeta();
      const stateJson = await store.store.getStorageState();
      if (meta) {
        const exp = meta.expiresAt ? new Date(meta.expiresAt).getTime() : 0;
        if (exp > 0 && now > exp) {
          sessionStatus.status = 'expired';
        } else {
          sessionStatus.status = 'ok';
        }
        sessionStatus.expiresAt = meta.expiresAt ?? null;
        sessionStatus.sessionVersion = meta.sessionVersion ?? null;
        sessionStatus.updatedAt = meta.updatedAt ?? null;
      }
      if (stateJson) {
        sessionStatus.storageStateBytes = Buffer.byteLength(stateJson, 'utf8');
      }
    }

    res.json({
      environment,
      validationRunnerUserId,
      oauth: oauthStatus,
      playwrightSession: sessionStatus,
    });
  });

  // ── Admin: Start OAuth for Validation Runner ───────────────────────────────

  app.post('/admin/oauth/start-for-validation', requireAdmin, async (req, res) => {
    const environment: EbayEnvironment = 'production';
    const validationRunnerUserId = getValidationRunnerUserId(environment);
    if (!validationRunnerUserId) {
      res.status(500).json({ error: 'VALIDATION_USER_NOT_CONFIGURED' });
      return;
    }

    const ebayConfig = getEbayConfig(environment);
    const ebayRedirectUri = ebayConfig.ruName || ebayConfig.redirectUri;
    if (!ebayConfig.clientId || !ebayConfig.clientSecret || !ebayRedirectUri) {
      res.status(500).json({ error: `Missing eBay configuration for ${environment}` });
      return;
    }

    const stateRecord = await authStore.createOAuthState(
      environment,
      undefined,
      undefined,
      validationRunnerUserId
    );

    const oauthUrl = getOAuthAuthorizationUrl(
      ebayConfig.clientId,
      ebayRedirectUri,
      environment,
      getHostedOauthScopes(environment),
      undefined,
      stateRecord.state
    );

    serverLogger.info(
      '[admin/oauth/start-for-validation] Started OAuth flow for validation runner',
      {
        userId: validationRunnerUserId,
        environment,
        state: stateRecord.state,
      }
    );

    res.json({
      ok: true,
      environment,
      targetUserId: validationRunnerUserId,
      oauthUrl,
      state: stateRecord.state,
      expiresAt: stateRecord.expiresAt,
    });
  });

  // ── Admin: Set Playwright Session ──────────────────────────────────────────

  app.post('/admin/playwright-session', requireAdmin, async (req, res) => {
    const { storageState, marketplace } = req.body as {
      storageState?: unknown;
      marketplace?: string;
    };

    if (storageState === undefined || storageState === null) {
      res.status(400).json({ error: 'Missing or invalid storageState object' });
      return;
    }

    const targetMarketplace = (marketplace ?? 'EBAY-US').toUpperCase();
    const store = createFreshEbayResearchSessionStoreResolution(targetMarketplace);

    if (!store.store) {
      res.status(500).json({
        error: `Session store backend not available: selected=${store.selected}`,
        backend: store.selected,
      });
      return;
    }

    const stateJson =
      typeof storageState === 'string' ? storageState : JSON.stringify(storageState);

    // Validate minimal structure. Accept either a full Playwright storage-state
    // object or a direct DevTools-exported cookie array, then normalize before
    // the shared validation+persistence path.
    let parsed: Record<string, unknown>;
    try {
      const parsedValue = JSON.parse(stateJson) as unknown;
      if (Array.isArray(parsedValue)) {
        parsed = { cookies: parsedValue, origins: [] };
      } else if (parsedValue && typeof parsedValue === 'object') {
        parsed = parsedValue as Record<string, unknown>;
      } else {
        res.status(400).json({ error: 'storageState is not valid Playwright storage-state JSON' });
        return;
      }

      if (!Array.isArray(parsed.cookies)) {
        res.status(400).json({
          error: 'storageState must contain a "cookies" array',
        });
        return;
      }
    } catch {
      res.status(400).json({ error: 'storageState is not valid JSON' });
      return;
    }

    const parsedStorageState: ResearchStorageState = {
      cookies: parsed.cookies as ResearchStorageState['cookies'],
      origins: Array.isArray(parsed.origins)
        ? (parsed.origins as ResearchStorageState['origins'])
        : [],
    };

    let persistence: Awaited<ReturnType<typeof validateAndStoreEbayResearchSessionToKv>>;
    try {
      persistence = await validateAndStoreEbayResearchSessionToKv(
        targetMarketplace,
        parsedStorageState,
        'storage_state'
      );
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
        backend: store.selected,
        storageStateKey: store.stateKey,
        metadataKey: store.metaKey,
      });
      return;
    }

    serverLogger.info('[admin/playwright-session] Stored Playwright session', {
      marketplace: targetMarketplace,
      backend: persistence.backend,
      bytes: persistence.bytes,
      expiresAt: persistence.expiresAt,
      validationStatus: persistence.validation.responseStatus,
    });

    res.json({
      ok: true,
      marketplace: targetMarketplace,
      backend: persistence.backend,
      storageStateKey: persistence.stateKey,
      metadataKey: persistence.metaKey,
      bytes: persistence.bytes,
      cookieCount: persistence.cookieCount,
      expiresAt: persistence.expiresAt,
      ttlSeconds: persistence.ttlSeconds,
      storeTtlSeconds: persistence.storeTtlSeconds,
      validation: persistence.validation,
    });
  });

  // ── Admin: Playwright Cookie Capture Page ──────────────────────────────────

  app.get('/admin/playwright-capture', requireAdmin, (_req, res) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
    );
    res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>eBay Research — Cookie Capture</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .step { background: #f7f7f8; border-radius: 10px; padding: 16px 20px; margin: 16px 0; }
    .step h3 { margin: 0 0 8px; font-size: 1rem; }
    .step p { margin: 4px 0; font-size: 0.9rem; color: #555; }
    .btn { display: inline-block; background: #111827; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 0.95rem; border: none; cursor: pointer; margin-top: 8px; }
    .btn:hover { background: #1f2937; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: #6b7280; }
    textarea { width: 100%; min-height: 160px; font-family: monospace; font-size: 0.85rem; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; resize: vertical; margin-top: 8px; }
    .status { padding: 10px 16px; border-radius: 8px; margin: 12px 0; font-size: 0.9rem; display: none; }
    .status.success { display: block; background: #d1fae5; color: #065f46; }
    .status.error { display: block; background: #fee2e2; color: #991b1b; }
    .status.info { display: block; background: #dbeafe; color: #1e40af; }
  </style>
</head>
<body>
  <h1>🔑 eBay Research Cookie Capture</h1>
  <p>This page captures your eBay Research session cookies so the validation pipeline can access sold listing data.</p>

  <div id="statusBox" class="status"></div>

  <div class="step">
    <h3>Step 1: Sign in to eBay Research</h3>
    <p>Open this link in your browser and sign in:</p>
    <a class="btn" href="https://www.ebay.com/sh/research?marketplace=EBAY-US" target="_blank" rel="noopener">Open eBay Research ↗</a>
  </div>

  <div class="step">
    <h3>Step 2: Copy Cookies from Browser</h3>
    <p><strong>Option A — Bookmarklet (quickest):</strong></p>
    <a class="btn btn-secondary" href="javascript:(function(){var c=document.cookie.split(/;\\s*/).map(function(x){var p=x.split('=');return{name:p[0],value:p.slice(1).join('=')}});var origins=[];try{origins=[{origin:'https://www.ebay.com',localStorage:Object.entries(localStorage).map(function(e){return{name:e[0],value:e[1]}})}]}catch(e){}var payload=JSON.stringify({cookies:c,origins:origins},null,2);var ta=document.createElement('textarea');ta.value=payload;document.body.appendChild(ta);ta.select();document.execCommand('copy');alert('Cookies copied to clipboard! ('+c.length+' cookies)');document.body.removeChild(ta);})();">Copy to Clipboard Bookmarklet ↗</a>
    <p style="font-size:0.8rem;color:#888;margin-top:8px;">Drag this link to your bookmarks bar, click it while on ebay.com, then return here and paste below.</p>
    <p style="margin-top:12px;"><strong>Option B — DevTools:</strong></p>
    <ol style="padding-left:20px;font-size:0.9rem;color:#555;">
      <li>Press <code>F12</code> → <strong>Application</strong> tab</li>
      <li>Left sidebar: <strong>Cookies</strong> → <code>https://www.ebay.com</code></li>
      <li>Right-click any cookie → <strong>Export as JSON</strong></li>
    </ol>
  </div>

  <div class="step">
    <h3>Step 3: Paste Cookies Here</h3>
    <p>Paste the exported cookie JSON below. It should look like <code>[{"name":"...","value":"..."},...]</code> or <code>{"cookies":[...],"origins":[...]}</code></p>
    <textarea id="cookieInput" placeholder="Paste cookie JSON here..."></textarea>
    <button class="btn" id="btnSubmit" onclick="submitCookies()">Submit Cookies</button>
  </div>

  <script>
    // Read admin key from query param so fetch calls are authenticated
    const urlParams = new URLSearchParams(window.location.search);
    const adminKey = urlParams.get('key') || '';

    const statusBox = document.getElementById('statusBox');
    function setStatus(msg, type) {
      statusBox.className = 'status ' + type;
      statusBox.textContent = msg;
    }

    async function submitCookies() {
      var input = document.getElementById('cookieInput').value.trim();
      if (!input) { setStatus('Please paste cookie JSON.', 'error'); return; }

      var parsed;
      try { parsed = JSON.parse(input); } catch(e) {
        setStatus('Invalid JSON: ' + e.message, 'error'); return;
      }

      var storageState;
      if (Array.isArray(parsed)) {
        storageState = { cookies: parsed, origins: [] };
      } else if (parsed.cookies) {
        storageState = parsed;
      } else {
        setStatus('Expected array of cookies or object with "cookies" key.', 'error'); return;
      }

      var btn = document.getElementById('btnSubmit');
      btn.disabled = true;
      btn.textContent = 'Submitting...';

      try {
        var resp = await fetch('/admin/playwright-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminKey },
          body: JSON.stringify({ storageState: storageState, marketplace: 'EBAY-US' })
        });
        var result = await resp.json();
        if (result.ok) {
          var expiryLabel = result.expiresAt ? result.expiresAt.slice(0,10) : 'session-cookie fallback';
          var validationLabel = result.validation && result.validation.responseStatus ? ', validation HTTP ' + result.validation.responseStatus : '';
          setStatus('✅ Cookies stored successfully! (' + result.bytes + ' bytes, expires: ' + expiryLabel + validationLabel + ')', 'success');
        } else {
          setStatus('Failed: ' + (result.error || 'unknown error'), 'error');
        }
      } catch(e) {
        setStatus('Network error: ' + e.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Submit Cookies';
    }
  </script>
</body>
</html>`);
  });

  // ── Admin: Live Server Browser / noVNC Research Rescue ────────────────────

  app.get('/admin/research-session/live', requireAdmin, (req, res) => {
    const status = getResearchLiveStatus();
    if (req.query.format === 'json') {
      res.json(status);
      return;
    }

    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
    );
    res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>eBay Research — Live Server Browser</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 18px; color: #111827; line-height: 1.55; }
    .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 14px 0; }
    .btn { display: inline-block; background: #111827; color: #fff; text-decoration: none; padding: 11px 18px; border-radius: 10px; border: 0; cursor: pointer; margin: 6px 8px 6px 0; }
    .btn.secondary { background: #4b5563; }
    .muted { color: #6b7280; font-size: .92rem; }
    code, pre { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 2px 6px; }
    pre { padding: 10px; white-space: pre-wrap; word-break: break-all; }
    .warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
    .ok { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
    .record-options { display: grid; gap: 6px; margin: 8px 0; max-height: 180px; overflow: auto; }
    .record-option { width: 100%; text-align: left; background: #fff; color: #111827; border: 1px solid #d1d5db; padding: 8px 10px; border-radius: 8px; }
    .record-option small { display: block; color: #6b7280; margin-top: 2px; }
  </style>
</head>
<body>
  <h1>🖥️ eBay Research Live Server Browser</h1>
  <p class="muted">Use this when Research/Terapeak returns <strong>Pardon Our Interruption</strong>. Open a headed server Chrome inside noVNC, solve/login manually, then persist the rescued Playwright storage state.</p>

  <div class="card ${status.enabled ? 'ok' : 'warn'}">
    <strong>noVNC status:</strong> ${status.enabled ? 'enabled' : 'not enabled for this container'}<br>
    <strong>DISPLAY:</strong> <code>${htmlEscape(status.display)}</code><br>
    <strong>Storage mirror:</strong> <code>${htmlEscape(status.storageStatePath)}</code> (${status.storageStateExists ? 'exists' : 'not written yet'})<br>
    <strong>Live browser PID:</strong> <code>${status.livePid ?? 'none'}</code>
  </div>

  <div class="card">
    <h3>1. Try auto-renew first</h3>
    <p class="muted">This is the normal path: attempt credential/captcha-provider renewal and store the session automatically. If eBay blocks it, this page stays as the manual fallback.</p>
    <button class="btn" onclick="autoRenewSession()">Attempt Auto-Renew</button>
    <pre id="autoRenewResult" class="muted"></pre>
  </div>

  <div class="card">
    <h3>2. Manual fallback: open / control server Chrome</h3>
    <p><a class="btn" href="${htmlEscape(status.noVncUrl)}" target="_blank" rel="noopener">Open noVNC ↗</a></p>
    <p class="muted">VNC password:</p>
    <pre>${htmlEscape(status.noVncPassword ?? '(password file not available yet — ENABLE_NOVNC may be off)')}</pre>
  </div>

  <div class="card">
    <h3>3. Start a Research browser tab</h3>
    <p class="muted">Optional: include query + validation ID so the browser opens the exact validation-bound page. You can also use the same Airtable validation record ID below to re-run just that record after persisting the live session.</p>
    <input id="query" placeholder="Search query, e.g. stray kids skzoo plush" style="width:100%;padding:10px;margin:6px 0;border:1px solid #d1d5db;border-radius:8px;">
    <input id="validationRecordSearch" placeholder="Search validation records by item/query/record ID" style="width:100%;padding:10px;margin:6px 0;border:1px solid #d1d5db;border-radius:8px;">
    <button class="btn secondary" onclick="loadValidationRecords()">Search Records</button>
    <div id="validationRecordOptions" class="record-options muted">Search results appear as: recordID - Item</div>
    <input id="validationId" placeholder="Selected Airtable validation record ID, e.g. rec..." style="width:100%;padding:10px;margin:6px 0;border:1px solid #d1d5db;border-radius:8px;">
    <button class="btn secondary" onclick="openLiveBrowser()">Start / Open Server Chrome</button>
    <pre id="openResult" class="muted"></pre>
  </div>

  <div class="card">
    <h3>4. Persist rescued session</h3>
    <p class="muted">After you clear login/challenge in noVNC and Research loads, click persist. This validates and stores the mirrored Playwright storage state into the configured Research session store.</p>
    <button class="btn secondary" onclick="persistLiveSession()">Persist Live Session</button>
    <pre id="persistResult" class="muted"></pre>
  </div>

  <div class="card">
    <h3>5. Re-run one Airtable validation record</h3>
    <p class="muted">Uses the Airtable validation record ID above and sends only that record through the Validation Data Runner. This writes the refreshed Terapeak/eBay metrics back to Airtable without kicking off the 200+ record sweep.</p>
    <button class="btn" onclick="runTargetedValidation()">Run Targeted Validation</button>
    <pre id="targetedValidationResult" class="muted"></pre>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const adminKey = urlParams.get('key') || '';
    async function postJson(path, body) {
      const resp = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminKey },
        body: JSON.stringify(body || {})
      });
      return await resp.json();
    }
    async function getJson(path) {
      const resp = await fetch(path, { headers: { 'X-Admin-API-Key': adminKey } });
      return await resp.json();
    }
    function selectValidationRecord(recordId, item, searchQuery) {
      document.getElementById('validationId').value = recordId;
      if (searchQuery && !document.getElementById('query').value.trim()) {
        document.getElementById('query').value = searchQuery;
      }
      document.getElementById('validationRecordSearch').value = recordId + ' - ' + item;
    }
    async function loadValidationRecords() {
      const container = document.getElementById('validationRecordOptions');
      const query = document.getElementById('validationRecordSearch').value.trim();
      container.textContent = 'Loading records...';
      const result = await getJson('/admin/validation/records?limit=25&query=' + encodeURIComponent(query));
      if (!result.ok) {
        container.textContent = result.message || result.error || 'Could not load validation records.';
        return;
      }
      if (!result.records.length) {
        container.textContent = 'No matching validation records.';
        return;
      }
      container.innerHTML = '';
      result.records.forEach(function(record) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'record-option';
        button.textContent = record.label;
        const small = document.createElement('small');
        small.textContent = [record.searchQuery, record.trackingCadence].filter(Boolean).join(' · ');
        button.appendChild(small);
        button.onclick = function() { selectValidationRecord(record.recordId, record.item, record.searchQuery); };
        container.appendChild(button);
      });
    }
    async function autoRenewSession() {
      document.getElementById('autoRenewResult').textContent = 'Attempting auto-renew (max 120s)...';
      const result = await postJson('/admin/research-session/auto-renew', {
        marketplace: 'EBAY-US',
        timeout: 120000
      });
      document.getElementById('autoRenewResult').textContent = JSON.stringify(result, null, 2);
    }
    async function openLiveBrowser() {
      const result = await postJson('/admin/research-session/live/open', {
        query: document.getElementById('query').value.trim(),
        validationId: document.getElementById('validationId').value.trim(),
        marketplace: 'EBAY-US'
      });
      document.getElementById('openResult').textContent = JSON.stringify(result, null, 2);
    }
    async function persistLiveSession() {
      const result = await postJson('/admin/research-session/live/persist', { marketplace: 'EBAY-US' });
      document.getElementById('persistResult').textContent = JSON.stringify(result, null, 2);
    }
    async function runTargetedValidation() {
      const validationId = document.getElementById('validationId').value.trim();
      if (!validationId) {
        document.getElementById('targetedValidationResult').textContent = 'Paste an Airtable validation record ID first (rec...).';
        return;
      }
      document.getElementById('targetedValidationResult').textContent = 'Running targeted validation for ' + validationId + '...';
      const result = await postJson('/admin/validation/run-record', {
        validationId,
        recordId: validationId,
        providerOptions: { skipTwitter: true }
      });
      document.getElementById('targetedValidationResult').textContent = JSON.stringify(result, null, 2);
    }
  </script>
</body>
</html>`);
  });

  app.post('/admin/research-session/live/open', requireAdmin, async (req, res) => {
    const marketplace = (req.body?.marketplace ?? 'EBAY-US').toUpperCase();
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    const validationId =
      typeof req.body?.validationId === 'string' ? req.body.validationId.trim() : '';
    const { spawn } = await import('child_process');

    const scriptPath = resolve(projectRoot, 'build', 'scripts', 'open-ebay-research-live.js');
    const args = [scriptPath, `--marketplace=${marketplace}`];
    if (query) args.push(`--query=${query}`);
    if (validationId) args.push(`--validation-id=${validationId}`);

    const child = spawn('node', args, {
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || `:${process.env.NOVNC_DISPLAY || '99'}`,
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    serverLogger.info('[admin/research-session/live/open] Started live Research browser', {
      pid: child.pid,
      marketplace,
      hasQuery: query.length > 0,
      validationId: validationId || null,
    });

    res.json({
      ok: true,
      pid: child.pid ?? null,
      marketplace,
      query: query || null,
      validationId: validationId || null,
      status: getResearchLiveStatus(),
    });
  });

  app.post('/admin/research-session/live/persist', requireAdmin, async (req, res) => {
    const marketplace = (req.body?.marketplace ?? 'EBAY-US').toUpperCase();
    const storageStatePath = getResearchLiveStorageStatePath();
    if (!existsSync(storageStatePath)) {
      res.status(404).json({
        ok: false,
        error: 'LIVE_STORAGE_STATE_NOT_FOUND',
        storageStatePath,
      });
      return;
    }

    let parsedStorageState: ResearchStorageState;
    try {
      parsedStorageState = JSON.parse(
        readFileSync(storageStatePath, 'utf8')
      ) as ResearchStorageState;
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: `Could not parse live storage state: ${error instanceof Error ? error.message : String(error)}`,
        storageStatePath,
      });
      return;
    }

    try {
      const persistence = await validateAndStoreEbayResearchSessionToKv(
        marketplace,
        parsedStorageState,
        'storage_state'
      );
      res.json({
        ok: true,
        marketplace,
        backend: persistence.backend,
        storageStateKey: persistence.stateKey,
        metadataKey: persistence.metaKey,
        bytes: persistence.bytes,
        cookieCount: persistence.cookieCount,
        expiresAt: persistence.expiresAt,
        validation: persistence.validation,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        marketplace,
        storageStatePath,
      });
    }
  });

  app.get('/admin/validation/records', requireAdmin, async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const requestedLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 25;
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 25, 1), 50);

    try {
      const records = await listValidationRecordOptions(query, limit);
      res.json({ ok: true, count: records.length, records });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      serverLogger.error('[admin/validation/records] Failed to list validation records', {
        error: message,
      });
      res.status(message === 'AIRTABLE_API_KEY_MISSING' ? 503 : 502).json({
        ok: false,
        error:
          message === 'AIRTABLE_API_KEY_MISSING'
            ? 'AIRTABLE_API_KEY_MISSING'
            : 'AIRTABLE_RECORD_LIST_FAILED',
        message:
          message === 'AIRTABLE_API_KEY_MISSING'
            ? 'Set AIRTABLE_API_KEY or AIRTABLE_PAT on the server to enable searchable validation records.'
            : message,
      });
    }
  });

  app.post('/admin/validation/run-record', requireAdmin, async (req, res) => {
    const recordId = getValidationRecordIdFromBody(req.body);
    if (!/^rec[A-Za-z0-9]+$/.test(recordId)) {
      res.status(400).json({
        ok: false,
        error: 'VALIDATION_RECORD_ID_REQUIRED',
        message: 'Provide an Airtable validation record ID such as recXXXXXXXXXXXXXX.',
      });
      return;
    }

    let beforeFields: AirtableFields | null = null;
    let beforeReadError: string | null = null;
    try {
      beforeFields = await fetchValidationRecordFields(recordId);
    } catch (error) {
      beforeReadError = error instanceof Error ? error.message : String(error);
    }

    const webhookUrl = getValidationRunnerWebhookUrl();
    const providerOptions =
      typeof req.body === 'object' && req.body !== null && 'providerOptions' in req.body
        ? (req.body as { providerOptions?: unknown }).providerOptions
        : undefined;
    const payload = {
      recordId,
      validationId: recordId,
      triggerSource: 'mcp_admin_targeted_validation',
      requestedAt: new Date().toISOString(),
      ...(providerOptions && typeof providerOptions === 'object' ? { providerOptions } : {}),
    };

    try {
      const response = await axios.post(webhookUrl, payload, {
        timeout: 120_000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      });
      const ok = response.status >= 200 && response.status < 300;

      let afterFields: AirtableFields | null = null;
      let afterReadError: string | null = null;
      try {
        afterFields = await fetchValidationRecordFields(recordId);
      } catch (error) {
        afterReadError = error instanceof Error ? error.message : String(error);
      }

      const transferSummary =
        afterFields || beforeFields
          ? buildValidationTransferSummary(recordId, beforeFields, afterFields, response.status)
          : null;

      serverLogger.info('[admin/validation/run-record] Targeted validation webhook completed', {
        recordId,
        status: response.status,
        ok,
        changedFieldCount:
          transferSummary && typeof transferSummary.changedFieldCount === 'number'
            ? transferSummary.changedFieldCount
            : null,
      });
      res.status(ok ? 200 : 502).json({
        ok,
        recordId,
        webhookStatus: response.status,
        result: response.data,
        transferSummary,
        airtableRead: {
          beforeOk: beforeReadError === null,
          afterOk: afterReadError === null,
          beforeError: beforeReadError,
          afterError: afterReadError,
        },
      });
    } catch (error) {
      serverLogger.error('[admin/validation/run-record] Targeted validation webhook failed', {
        recordId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        ok: false,
        recordId,
        error: 'TARGETED_VALIDATION_WEBHOOK_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Admin: Auto-Renew eBay Research Session ──────────────────────────────

  app.post('/admin/research-session/auto-renew', requireAdmin, async (req, res) => {
    const marketplace = (req.body?.marketplace ?? 'EBAY-US').toUpperCase();
    const requestedTimeoutMs = typeof req.body?.timeout === 'number' ? req.body.timeout : 120_000;
    const timeoutMs = Math.min(Math.max(requestedTimeoutMs, 1_000), 120_000);

    serverLogger.info('[admin/research-session/auto-renew] Starting auto-renewal', {
      marketplace,
      timeoutMs,
    });

    // Import the auto-renew script — it runs the full flow in a spawned process
    const { spawn } = await import('child_process');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = resolve(
      currentDir,
      '..',
      'build',
      'scripts',
      'auto-renew-ebay-research-session.js'
    );

    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        EBAY_RESEARCH_BOOTSTRAP_MARKETPLACE: marketplace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timer);

      if (timedOut) {
        serverLogger.error('[admin/research-session/auto-renew] Timed out', {
          marketplace,
          timeoutMs,
          partialStdout: stdout.slice(-2000),
        });
        res.status(504).json({
          ok: false,
          marketplace,
          error: `Auto-renewal timed out after ${timeoutMs}ms`,
          partialOutput: stdout.slice(-2000),
        });
        return;
      }

      // Try to parse JSON output from the script. Success JSON is written to
      // stdout; structured failure JSON is written to stderr.
      const parseTrailingJson = (text: string): Record<string, unknown> | null => {
        const jsonMatch = /\n(\{[\s\S]*\})\s*$/.exec(`\n${text.trim()}`);
        if (!jsonMatch) {
          return null;
        }
        try {
          return JSON.parse(jsonMatch[1]) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      const parsedResult = parseTrailingJson(stdout) ?? parseTrailingJson(stderr);

      if (exitCode === 0 && parsedResult?.ok === true) {
        const r = parsedResult;
        serverLogger.info('[admin/research-session/auto-renew] Success', {
          marketplace,
          bytes: (r.validationPersistence as Record<string, unknown> | undefined)?.bytes,
          cookieCount: (r.validationPersistence as Record<string, unknown> | undefined)
            ?.cookieCount,
        });
        res.json({
          ok: true,
          marketplace,
          ...parsedResult,
        });
      } else if (parsedResult?.errorCode === 'MANUAL_RESEARCH_SESSION_REQUIRED') {
        serverLogger.warn('[admin/research-session/auto-renew] Manual capture required', {
          marketplace,
          exitCode,
          challengeType: parsedResult.challengeType,
          challengeUrl: parsedResult.challengeUrl,
        });
        res.status(409).json({
          ok: false,
          marketplace,
          ...parsedResult,
        });
      } else {
        const errorMsg = parsedResult?.error ?? stderr.slice(-1000) ?? `Exit code ${exitCode}`;
        serverLogger.error('[admin/research-session/auto-renew] Failed', {
          marketplace,
          exitCode,
          error: errorMsg,
        });
        res.status(500).json({
          ok: false,
          marketplace,
          exitCode,
          error: errorMsg,
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-1000),
        });
      }
    });
  });

  // ── Single OAuth callback
  // ── Single OAuth callback (registered with eBay — must be one fixed URL) ─
  // The environment is recovered from the state record, not the URL path.
  app.get('/oauth/callback', async (req, res) => {
    await handleOAuthCallback(req, res, serverUrl);
  });

  // ── Mount env-scoped route trees ─────────────────────────────────────────
  // Each tree hard-binds its environment so no ?env= query param is needed.
  app.use('/sandbox', mountEnvRouter('sandbox', serverUrl, iconBaseUrl));
  app.use('/production', mountEnvRouter('production', serverUrl, iconBaseUrl));

  // ── Root / backward-compat MCP routes (env resolved from ?env= or EBAY_ENVIRONMENT) ─
  app.use(mountEnvRouter(null, serverUrl, iconBaseUrl));

  return app;
}

// ── Environment-scoped router factory ────────────────────────────────────
/**
 * Creates an Express router with all MCP OAuth 2.1 + MCP endpoints for a
 * specific environment.
 *
 * @param hardcodedEnv  `'sandbox'` | `'production'` to hard-bind, or `null`
 *                      for the legacy auto-detect behaviour (reads `?env=` or
 *                      `EBAY_ENVIRONMENT`).
 * @param serverUrl     Canonical server origin, e.g. `https://my.host.com`.
 * @param iconBaseUrl   Full URL prefix for icon assets.
 */
function mountEnvRouter(
  hardcodedEnv: EbayEnvironment | null,
  serverUrl: string,
  iconBaseUrl: string
): express.Router {
  const router = express.Router();

  // The base URL that MCP clients will use for this router tree.
  // e.g. "https://my.host.com/sandbox" or "https://my.host.com" (root).
  const prefix = hardcodedEnv ?? '';
  const routeBaseUrl = hardcodedEnv ? `${serverUrl}/${hardcodedEnv}` : serverUrl;

  function resolveEnv(req: express.Request): EbayEnvironment {
    if (hardcodedEnv) return hardcodedEnv;
    const q = req.query as Record<string, string>;
    if (q.env === 'sandbox' || q.env === 'production') return q.env;

    // For root router, detect environment from available signals in priority order:
    //
    //   1. `resource` query param (RFC 9728) — MCP clients like Cline include the
    //      full target MCP URL, e.g. resource=https://host/sandbox/mcp, which
    //      encodes the env directly in its path.
    //
    //   2. Per-env RuNames (EBAY_SANDBOX_RUNAME / EBAY_PRODUCTION_RUNAME) via
    //      -SB- / -PR- segment — if only ONE is configured, it's definitive.
    //      If BOTH are configured they conflict; skip to next step.
    //
    //   3. Generic RuName (EBAY_RUNAME / legacy EBAY_REDIRECT_URI) to disambiguate
    //      when both or neither env-specific vars are set.
    //
    //   4. EBAY_ENVIRONMENT env var — last resort only.

    // Step 1: resource param (most reliable for RFC 9728-aware clients).
    const resourceParam = q.resource;
    if (resourceParam) {
      if (resourceParam.includes('/sandbox/') || resourceParam.endsWith('/sandbox')) {
        return 'sandbox';
      }
      if (resourceParam.includes('/production/') || resourceParam.endsWith('/production')) {
        return 'production';
      }
    }

    // Step 2: per-env RuName detection.
    const sandboxRuName = process.env.EBAY_SANDBOX_RUNAME ?? process.env.EBAY_SANDBOX_REDIRECT_URI;
    const productionRuName =
      process.env.EBAY_PRODUCTION_RUNAME ?? process.env.EBAY_PRODUCTION_REDIRECT_URI;
    const genericRuName = process.env.EBAY_RUNAME ?? process.env.EBAY_REDIRECT_URI;

    const sandboxDetected = ruNameToEnvironment(sandboxRuName);
    const productionDetected = ruNameToEnvironment(productionRuName);

    if (sandboxDetected && !productionDetected) return 'sandbox';
    if (productionDetected && !sandboxDetected) return 'production';

    // Step 3: generic RuName to disambiguate when both/neither env-specific are set.
    const genericDetected = ruNameToEnvironment(genericRuName);
    if (genericDetected) return genericDetected;

    // Step 4: final fallback.
    return getConfiguredEnvironment();
  }

  router.post('/validation/run', requireAdmin, async (req, res) => {
    const environment = resolveEnv(req);
    const validationRunnerUserId = getValidationRunnerUserId(environment);

    if (!validationRunnerUserId) {
      res.status(500).json({
        status: 'error',
        validationId: getValidationIdFromBody(req.body),
        errorCode: 'VALIDATION_USER_NOT_CONFIGURED',
        message: `No validation runner user is configured for ${environment}`,
        retryable: false,
        nextCheckAt: null,
      });
      return;
    }

    const storedTokens = await authStore.getUserTokens(validationRunnerUserId, environment);
    if (!storedTokens?.tokenData) {
      res.status(500).json({
        status: 'error',
        validationId: getValidationIdFromBody(req.body),
        errorCode: 'VALIDATION_USER_TOKENS_MISSING',
        message: `Stored refresh-token-backed credentials were not found for validation user ${validationRunnerUserId} in ${environment}`,
        retryable: false,
        nextCheckAt: null,
      });
      return;
    }

    try {
      const api = await createUserScopedApi(validationRunnerUserId, environment);
      const { runValidation } = await import('./validation/run-validation.js');
      const result = await runValidation(api, req.body);

      if (result.status === 'error') {
        res.status(500).json(result);
        return;
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        validationId: getValidationIdFromBody(req.body),
        errorCode: 'VALIDATION_ROUTE_ERROR',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        nextCheckAt: getRetryTimestampFromBody(req.body),
      });
    }
  });

  router.get('/validation/health', requireAdmin, async (req, res) => {
    const environment = resolveEnv(req);
    const validationRunnerUserId = getValidationRunnerUserId(environment);
    const storedTokens = validationRunnerUserId
      ? await authStore.getUserTokens(validationRunnerUserId, environment)
      : null;
    const socialConfig = {
      hasTwitterBearerToken: Boolean(process.env.TWITTER_BEARER_TOKEN?.trim()),
      hasYoutubeApiKey: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
      hasRedditUserAgent: Boolean(process.env.REDDIT_USER_AGENT?.trim()),
    };

    let authenticated = false;
    let authError: string | null = null;
    let tokenStatus: ReturnType<EbaySellerApi['getTokenInfo']> | null = null;
    let authDebug: {
      tokenEndpoint: string;
      environment: 'production' | 'sandbox';
      hasClientId: boolean;
      hasClientSecret: boolean;
      hasRefreshToken: boolean;
      hasAccessToken: boolean;
      hasRedirectUri: boolean;
      configuredMarketplaceId: string;
      configuredContentLanguage: string;
      refreshTokenExpiry?: number;
      accessTokenExpiry?: number;
      source?:
        | 'stored_user_tokens'
        | 'env_refresh_token_fallback'
        | 'authorization_code_exchange'
        | 'manual_set_user_tokens';
      responseStatus?: number | null;
      responseBodyExcerpt?: string | null;
    } | null = null;

    if (validationRunnerUserId && storedTokens?.tokenData) {
      try {
        const api = await createUserScopedApi(validationRunnerUserId, environment);
        const oauthClient = api.getAuthClient().getOAuthClient();
        const config = api.getAuthClient().getConfig();
        authDebug = {
          ...oauthClient.getAuthDebugInfo(),
          configuredMarketplaceId: config.marketplaceId ?? '',
          configuredContentLanguage: config.contentLanguage ?? '',
        };
        await api.getAuthClient().getOAuthClient().getAccessToken();
        authenticated = true;
        tokenStatus = api.getTokenInfo();
      } catch (error) {
        authError = error instanceof Error ? error.message : String(error);
        const failureDebug = getAxiosFailureDebug(error);
        authDebug = authDebug
          ? {
              ...authDebug,
              responseStatus: failureDebug.responseStatus,
              responseBodyExcerpt: failureDebug.responseBodyExcerpt,
            }
          : null;
        serverLogger.error('Validation health auth check failed', {
          environment,
          validationRunnerUserId,
          tokenEndpoint: authDebug?.tokenEndpoint ?? null,
          responseStatus: failureDebug.responseStatus,
          responseBodyExcerpt: failureDebug.responseBodyExcerpt,
          authError,
        });
      }
    }

    const healthResponse = {
      status: authenticated ? 'ok' : 'degraded',
      environment,
      validationRunnerUserId,
      hasStoredTokens: !!storedTokens?.tokenData,
      authenticated,
      tokenStatus,
      authDebug,
      providers: {
        ebay: { available: true, implemented: true, confidence: 'medium' },
        social: { available: false, implemented: false, confidence: 'low' },
        chart: { available: false, implemented: false, confidence: 'low' },
        socialConfig,
      },
      ...(authError ? { authError } : {}),
    };

    serverLogger.info('Validation health response emitted', {
      environment,
      path: req.originalUrl,
      status: healthResponse.status,
      version: getVersion(),
      hasSocialConfigAtRoot: Object.prototype.hasOwnProperty.call(healthResponse, 'socialConfig'),
      hasSocialConfigUnderProviders: Object.prototype.hasOwnProperty.call(
        healthResponse.providers,
        'socialConfig'
      ),
      providerKeys: Object.keys(healthResponse.providers),
      socialConfig,
    });

    res.json(healthResponse);
  });

  // ── RFC 8414 – Authorization Server Metadata ──────────────────────────
  // For env-scoped routers: endpoints are relative to the env base URL.
  // For the ROOT router: endpoints are relative to the DEFAULT environment's
  // base URL (not root). This ensures that MCP clients that cached root
  // auth-server discovery (e.g. Cline) see env-specific authorize/token/
  // register URLs and update their cached endpoints on the next request.
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    // env-scoped: use as-is; root: redirect to the configured default env sub-path
    const endpointBase = hardcodedEnv ? routeBaseUrl : `${serverUrl}/${getConfiguredEnvironment()}`;
    res.json({
      issuer: routeBaseUrl,
      authorization_endpoint: `${endpointBase}/authorize`,
      token_endpoint: `${endpointBase}/token`,
      registration_endpoint: `${endpointBase}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // ── RFC 7591 – Dynamic Client Registration ────────────────────────────
  router.post('/register', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const redirectUris = body.redirect_uris;
    const clientName = typeof body.client_name === 'string' ? body.client_name : undefined;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
      });
      return;
    }

    const uris = redirectUris as string[];
    // Tag the registered client with the env so that root /authorize can use
    // client.environment as a fallback when no ?env= param is present.
    const client = await authStore.registerClient(uris, clientName, hardcodedEnv ?? undefined);
    serverLogger.info(`[${prefix || 'root'}/register] MCP client registered`, {
      clientId: client.clientId,
      redirectUris: client.redirectUris,
    });
    res.status(201).json({
      client_id: client.clientId,
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  // ── RFC 6749 – Authorization Endpoint (PKCE required) ────────────────
  router.get('/authorize', requireOauthStartKey, async (req, res) => {
    try {
      const q = req.query as Record<string, string>;
      const {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: responseType,
        state: mcpState,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
      } = q;
      // Environment resolution (in priority order):
      //   1. URL path prefix (/sandbox, /production) → authoritative  [hardcodedEnv]
      //   2. Explicit ?env= query param
      //   3. ?resource param (RFC 9728 — full MCP URL encodes env in its path)
      //   4. RuName -SB-/-PR- segment / EBAY_ENVIRONMENT fallback (see resolveEnv)
      const envSource = hardcodedEnv
        ? 'path'
        : q.env === 'sandbox' || q.env === 'production'
          ? 'query'
          : q.resource && (q.resource.includes('/sandbox/') || q.resource.includes('/production/'))
            ? 'resource'
            : 'runame';
      let environment = resolveEnv(req);

      serverLogger.info(`[${prefix || 'root'}/authorize] Request received`, {
        clientId,
        redirectUri,
        responseType,
        hasPkce: !!codeChallenge,
        pkceMethod: codeChallengeMethod,
        environment,
        envSource,
        hasMcpState: !!mcpState,
      });

      if (responseType !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }
      if (!clientId) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'client_id is required' });
        return;
      }

      let client = await authStore.getClient(clientId);

      // For root router (hardcodedEnv = null): if the client was previously
      // registered through an env-scoped path (e.g. /sandbox/register), use
      // that env instead of the generic fallback — even if ?env= was not sent.
      // This fixes the case where Cline has cached root /authorize but the
      // client record was tagged as sandbox from an earlier discovery pass.
      if (!hardcodedEnv && client?.environment) {
        if (environment !== client.environment) {
          serverLogger.info(`[root/authorize] Overriding env from client registration`, {
            clientId,
            resolvedEnv: environment,
            clientEnv: client.environment,
          });
          environment = client.environment;
        }
      }

      if (!client) {
        if (redirectUri && isTrustedDesktopRedirectUri(redirectUri)) {
          serverLogger.info(
            `[${prefix || 'root'}/authorize] Auto-registering trusted desktop MCP client`,
            { clientId, redirectUri }
          );
          // Tag the new client with the already-resolved env so subsequent root
          // /authorize calls also land on the correct env without re-discovery.
          client = await authStore.registerClientWithId(
            clientId,
            [redirectUri],
            undefined,
            environment
          );
        } else {
          serverLogger.warn(`[${prefix || 'root'}/authorize] Rejected: unknown client_id`, {
            clientId,
            redirectUri,
          });
          res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
          return;
        }
      }
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri not registered for this client',
        });
        return;
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'PKCE with S256 code_challenge is required',
        });
        return;
      }

      const ebayConfig = getEbayConfig(environment);
      const ebayRedirectUri = getEbayOAuthRedirectUri(ebayConfig);
      if (!ebayConfig.clientId || !ebayConfig.clientSecret || !ebayRedirectUri) {
        res.status(500).json({
          error: 'server_error',
          error_description: `Missing eBay configuration for ${environment}`,
        });
        return;
      }

      // Validate that the loaded credentials (RuName segment) actually match the
      // requested environment.  This is the authoritative check — if the RuName
      // contains -PR- but the request is for sandbox (or vice-versa), we must
      // fail fast rather than silently issuing tokens for the wrong environment.
      const credCheck = validateCredentialsForEnvironment(environment);
      serverLogger.info(`[${prefix || 'root'}/authorize] Credential check`, {
        environment,
        envSource,
        ruName: ebayRedirectUri,
        ruNameDetectedEnv: credCheck.detectedEnv,
        credentialValid: credCheck.valid,
      });
      if (!credCheck.valid) {
        serverLogger.error(`[${prefix || 'root'}/authorize] RuName/environment mismatch`, {
          error: credCheck.error,
        });
        res.status(500).json({
          error: 'server_misconfiguration',
          error_description: credCheck.error,
        });
        return;
      }

      const stateRecord = await authStore.createOAuthState(environment, undefined, {
        mcpClientId: clientId,
        mcpRedirectUri: redirectUri,
        mcpState,
        mcpCodeChallenge: codeChallenge,
        mcpCodeChallengeMethod: codeChallengeMethod,
      });

      const oauthUrl = getOAuthAuthorizationUrl(
        ebayConfig.clientId,
        ebayRedirectUri,
        environment,
        getHostedOauthScopes(environment),
        undefined,
        stateRecord.state
      );
      serverLogger.info(`[${prefix || 'root'}/authorize] Redirecting to eBay OAuth`, {
        state: stateRecord.state,
        environment,
        ruName: ebayRedirectUri,
        expectedCallbackUrl: getExpectedOAuthCallbackUrl(serverUrl),
      });
      res.redirect(oauthUrl);
    } catch (error) {
      serverLogger.error(`[${prefix || 'root'}/authorize] Unhandled error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'server_error',
        error_description: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── RFC 6749 – Token Endpoint ─────────────────────────────────────────
  router.post('/token', async (req, res) => {
    // Entry-level log fires before ANY validation so we can confirm whether
    // Cline's token request reaches the server at all.  If this log never
    // appears after a successful vscode:// deep-link redirect, the request
    // is being dropped before it reaches the server (TLS trust issue, wrong
    // URL, or the deep link is silently swallowed by VS Code).
    serverLogger.info(`[${prefix || 'root'}/token] Request received`, {
      contentType: req.headers['content-type'],
      origin: req.headers.origin,
      hasBody: !!req.body,
    });

    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Request body is missing or unparseable.',
      });
      return;
    }

    const body = req.body as Record<string, string>;
    const {
      grant_type: grantType,
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    } = body;

    if (grantType !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      return;
    }

    const authCode = await authStore.consumeAuthCode(code);
    if (!authCode) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      });
      return;
    }

    serverLogger.info(`[${prefix || 'root'}/token] Auth code found`, {
      storedClientId: authCode.clientId,
      providedClientId: clientId,
    });

    if (authCode.clientId !== clientId) {
      res.status(400).json({ error: 'invalid_client', error_description: 'client_id mismatch' });
      return;
    }
    if (authCode.redirectUri !== redirectUri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    if (!codeVerifier) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'code_verifier is required' });
      return;
    }

    const expectedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      res
        .status(400)
        .json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    const session = await authStore.createSession(authCode.userId, authCode.environment);
    serverLogger.info(`[${prefix || 'root'}/token] Session created`, {
      userId: authCode.userId,
      environment: authCode.environment,
      expiresAt: session.expiresAt,
    });
    res.json({
      access_token: session.sessionToken,
      token_type: 'bearer',
      scope: 'mcp',
    });
  });

  // ── OAuth start (browser-initiated non-MCP flow) ──────────────────────
  router.get('/oauth/start', requireOauthStartKey, async (req, res) => {
    try {
      const environment = resolveEnv(req);
      const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
      const ebayConfig = getEbayConfig(environment);
      const ebayRedirectUri = getEbayOAuthRedirectUri(ebayConfig);
      if (!ebayConfig.clientId || !ebayConfig.clientSecret || !ebayRedirectUri) {
        res.status(500).json({ error: `Missing eBay configuration for ${environment}` });
        return;
      }
      const stateRecord = await authStore.createOAuthState(environment, returnTo);
      const oauthUrl = getOAuthAuthorizationUrl(
        ebayConfig.clientId,
        ebayRedirectUri,
        environment,
        getHostedOauthScopes(environment),
        undefined,
        stateRecord.state
      );
      serverLogger.info(`[${prefix || 'root'}/oauth/start] Redirecting to eBay OAuth`, {
        state: stateRecord.state,
        environment,
        ruName: ebayRedirectUri,
        expectedCallbackUrl: getExpectedOAuthCallbackUrl(serverUrl),
        returnTo,
      });
      res.redirect(oauthUrl);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ── MCP endpoint ──────────────────────────────────────────────────────

  const authenticateSession = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    const requestedEnv = resolveEnv(req);
    const setUserContext = (
      userId: string,
      environment: EbayEnvironment,
      sessionToken: string
    ): void => {
      (
        req as express.Request & {
          userContext?: { userId: string; environment: EbayEnvironment; sessionToken: string };
        }
      ).userContext = {
        userId,
        environment,
        sessionToken,
      };
    };

    const sendAuthorizationRequired = (
      reason: 'missing_session_token' | 'invalid_session_token'
    ): void => {
      const oauthStartPath = `${routeBaseUrl}/oauth/start`;
      const oauthUrl = new URL(oauthStartPath);
      // Only append ?env= for the root (auto) router; env-scoped routers are self-describing.
      if (!hardcodedEnv) {
        oauthUrl.searchParams.set('env', requestedEnv);
      }
      if (CONFIG.oauthStartKey) {
        oauthUrl.searchParams.set('key', CONFIG.oauthStartKey);
      }

      // RFC 9728 §5.1 / RFC 6750: include resource_metadata in WWW-Authenticate
      // so that MCP clients (Cline, Claude Desktop, etc.) can discover the
      // correct env-scoped authorization server without probing well-known URLs.
      // The path-based well-known URI for a resource at /sandbox/mcp is
      //   /.well-known/oauth-protected-resource/sandbox/mcp
      // For the root MCP path we fall back to the generic well-known endpoint.
      const resourcePath = req.path; // e.g. "" (when router is at /sandbox)
      const fullResourcePath = hardcodedEnv ? `/${hardcodedEnv}${resourcePath}` : resourcePath;
      // Normalise: strip trailing slashes, ensure it does not double-encode
      const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource${fullResourcePath.replace(/\/$/, '')}`;

      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl}"`
      );

      if (req.method === 'GET') {
        res.redirect(oauthUrl.toString());
        return;
      }

      res.status(401).json({
        error: reason,
        authorization_required: true,
        environment: requestedEnv,
        authorization_url: oauthUrl.toString(),
        resource_metadata: resourceMetadataUrl,
        message:
          'No valid hosted session token was provided. Complete the browser OAuth flow using authorization_url, then retry with Authorization: Bearer <session-token>.',
      });
    };

    const isServerRequest = isTruthyHeader(getSingleHeader(req, 'x-ebay-server-request'));

    if (isServerRequest) {
      const headerClientId = getSingleHeader(req, 'x-ebay-client-id');
      const headerUserId = getSingleHeader(req, 'x-ebay-user-id');
      const headerEnvironment = getSingleHeader(req, 'x-ebay-environment');
      const serverEnv =
        headerEnvironment === 'sandbox' || headerEnvironment === 'production'
          ? headerEnvironment
          : requestedEnv;

      if (headerClientId && headerUserId) {
        const stored = await authStore.getUserTokensByClientUser(
          headerClientId,
          headerUserId,
          serverEnv
        );
        if (stored?.tokenData) {
          setUserContext(stored.userId, stored.environment, '__server_headers__');
          next();
          return;
        }
      }

      if (authHeader?.startsWith('Bearer ')) {
        const bearerToken = authHeader.slice('Bearer '.length).trim();
        const stored = await authStore.getUserTokensByServerBearerToken(bearerToken);
        if (stored?.tokenData && stored.environment === serverEnv) {
          setUserContext(stored.userId, stored.environment, '__server_bearer__');
          next();
          return;
        }
      }

      res.status(401).json({
        error: 'invalid_server_request_auth',
        authorization_required: true,
        environment: serverEnv,
        message:
          'Server requests require X-Ebay-Server-Request: true plus X-Ebay-Client-Id and X-Ebay-User-Id headers, or a valid Authorization: Bearer <server-token>.',
      });
      return;
    }

    if (!authHeader?.startsWith('Bearer ')) {
      sendAuthorizationRequired('missing_session_token');
      return;
    }
    const bearerToken = authHeader.slice('Bearer '.length).trim();

    if (CONFIG.adminApiKey && bearerToken === CONFIG.adminApiKey) {
      setUserContext('admin', requestedEnv, '__admin__');
      next();
      return;
    }

    const session = await authStore.getSession(bearerToken);
    if (!session || session.revokedAt) {
      sendAuthorizationRequired('invalid_session_token');
      return;
    }
    await authStore.touchSession(bearerToken);
    setUserContext(session.userId, session.environment, bearerToken);
    next();
  };

  async function createMcpServer(userId: string, environment: EbayEnvironment): Promise<McpServer> {
    let getToolDefinitions: typeof GetToolDefinitionsFn;
    let executeTool: typeof ExecuteToolFn;

    try {
      ({ getToolDefinitions, executeTool } = await import('./tools/index.js'));
    } catch (error) {
      serverLogger.error('Failed to import MCP tool registry', {
        userId,
        environment,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const api = await createUserScopedApi(userId, environment);
    const server = new McpServer({
      name: 'ebay-mcp-remote-edition',
      version: getVersion(),
      title: 'eBay MCP Server',
      websiteUrl: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
      icons: [
        { src: `${iconBaseUrl}/16x16.png`, mimeType: 'image/png', sizes: ['16x16'] },
        { src: `${iconBaseUrl}/32x32.png`, mimeType: 'image/png', sizes: ['32x32'] },
        { src: `${iconBaseUrl}/48x48.png`, mimeType: 'image/png', sizes: ['48x48'] },
      ],
    });

    // Configurable tool execution timeout (60s default — most tools complete in <10s)
    // Longer than individual API timeouts (30s) to allow for token refresh + API chaining
    const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 60_000);

    const tools = getToolDefinitions();
    for (const toolDef of tools) {
      try {
        server.registerTool(
          toolDef.name,
          { description: toolDef.description, inputSchema: toolDef.inputSchema },
          async (args: Record<string, unknown>) => {
            const startTime = Date.now();
            try {
              // Wrap tool execution with timeout to prevent indefinite hangs
              const result = await Promise.race([
                executeTool(api, toolDef.name, args),
                new Promise<never>((_, reject) => {
                  setTimeout(
                    () =>
                      reject(
                        new Error(`Tool ${toolDef.name} timed out after ${TOOL_TIMEOUT_MS}ms`)
                      ),
                    TOOL_TIMEOUT_MS
                  );
                }),
              ]);
              const duration = Date.now() - startTime;
              serverLogger.info(`[tool-exec] ${toolDef.name}`, {
                userId,
                environment,
                durationMs: duration,
                status: 'success',
              });
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              };
            } catch (error) {
              const duration = Date.now() - startTime;
              serverLogger.warn(`[tool-exec] ${toolDef.name}`, {
                userId,
                environment,
                durationMs: duration,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      { error: error instanceof Error ? error.message : String(error) },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              };
            }
          }
        );
      } catch (error) {
        serverLogger.error('Failed to register MCP tool', {
          toolName: toolDef.name,
          userId,
          environment,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return server;
  }

  const mcpPostHandler = async (req: express.Request, res: express.Response): Promise<void> => {
    const userContext = (
      req as express.Request & { userContext?: { userId: string; environment: EbayEnvironment } }
    ).userContext;
    if (!userContext) {
      res.status(401).json({ error: 'missing_user_context' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      try {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            serverLogger.info('New MCP session initialized', {
              sessionId: newSessionId,
              userId: userContext.userId,
              environment: userContext.environment,
            });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        const server = await createMcpServer(userContext.userId, userContext.environment);
        await server.connect(transport);
      } catch (error) {
        serverLogger.error('Failed to initialize MCP session', {
          userId: userContext.userId,
          environment: userContext.environment,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Failed to initialize MCP session',
          },
          id: null,
        });
        return;
      }
    } else {
      serverLogger.warn('Rejected MCP request without valid transport session', {
        hasSessionId: !!sessionId,
        sessionId,
        isInitialize: isInitializeRequest(req.body),
        userId: userContext.userId,
        environment: userContext.environment,
      });
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  };

  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response
  ): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res
        .status(400)
        .json({ error: 'invalid_session', error_description: 'Invalid or missing session ID' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  };

  router.post('/mcp', authenticateSession, mcpPostHandler);
  router.get('/mcp', authenticateSession, handleSessionRequest);
  router.delete('/mcp', authenticateSession, handleSessionRequest);

  return router;
}

// ── eBay OAuth callback ───────────────────────────────────────────────────
// This is mounted once at root because eBay requires a single registered
// redirect URI per app. The environment is recovered from the stored state.
async function handleOAuthCallback(
  req: express.Request,
  res: express.Response,
  serverUrl: string
): Promise<void> {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const oauthError = typeof req.query.error === 'string' ? req.query.error : undefined;
    const errorDescription =
      typeof req.query.error_description === 'string' ? req.query.error_description : undefined;

    serverLogger.info('[oauth/callback] Received', {
      hasCode: !!code,
      hasState: !!state,
      oauthError,
      expectedCallbackUrl: getExpectedOAuthCallbackUrl(serverUrl),
      actualCallbackUrl: `${serverUrl}${req.originalUrl}`,
    });

    if (oauthError) {
      res
        .status(400)
        .send(`<h1>OAuth failed</h1><p>${htmlEscape(errorDescription ?? oauthError)}</p>`);
      return;
    }
    if (!code) {
      res.status(400).send('<h1>Missing authorization code</h1>');
      return;
    }

    if (!state) {
      serverLogger.warn('[oauth/callback] Missing OAuth state in callback');
      res
        .status(400)
        .send(
          "<h1>Missing OAuth state</h1><p>Restart the OAuth flow from this server's /oauth/start or /authorize endpoint.</p>"
        );
      return;
    }

    const stateRecord = await authStore.getOAuthState(state);
    if (!stateRecord) {
      serverLogger.warn('[oauth/callback] OAuth state not found or expired', { state });
      res.status(400).send('<h1>Invalid or expired OAuth state</h1>');
      return;
    }

    const environment: EbayEnvironment = stateRecord.environment;
    serverLogger.info('[oauth/callback] State resolved', {
      environment,
      isMcpFlow: !!(stateRecord.mcpClientId && stateRecord.mcpRedirectUri),
      hasTargetUserId: !!stateRecord.targetUserId,
    });

    const ebayConfig = getEbayConfig(environment);
    serverLogger.info('[oauth/callback] Prepared eBay token exchange', {
      environment,
      tokenBaseUrl: getBaseUrl(environment),
      clientIdPrefix: ebayConfig.clientId ? `${ebayConfig.clientId.slice(0, 12)}...` : '(missing)',
      ruName: (ebayConfig.ruName || ebayConfig.redirectUri) ?? '(missing)',
    });

    // If targetUserId is set (e.g. validation runner flow), use it instead of generating random UUID
    const userId = stateRecord.targetUserId ?? randomUUID();
    const api = await createUserScopedApi(userId, environment);
    const oauthClient = api.getAuthClient().getOAuthClient();
    serverLogger.info('[oauth/callback] Exchanging code for eBay tokens', {
      userId,
      isTargetUserId: !!stateRecord.targetUserId,
    });
    const tokenData = await oauthClient.exchangeCodeForToken(code);
    await authStore.deleteOAuthState(state);
    serverLogger.info('[oauth/callback] eBay token exchange successful', {
      userId,
      hasScope: !!tokenData.scope,
    });

    // ── MCP OAuth flow: redirect back to the registered MCP client ────────
    if (stateRecord?.mcpClientId && stateRecord.mcpRedirectUri && stateRecord.mcpCodeChallenge) {
      const authCodeRecord = await authStore.createAuthCode(
        stateRecord.mcpClientId,
        stateRecord.mcpRedirectUri,
        stateRecord.mcpCodeChallenge,
        stateRecord.mcpCodeChallengeMethod ?? 'S256',
        userId,
        environment
      );
      const redirectUrl = new URL(stateRecord.mcpRedirectUri);
      redirectUrl.searchParams.set('code', authCodeRecord.code);
      if (stateRecord.mcpState) {
        redirectUrl.searchParams.set('state', stateRecord.mcpState);
      }
      const finalRedirectUrl = redirectUrl.toString();
      serverLogger.info('[oauth/callback] MCP OAuth flow complete, redirecting to client', {
        clientId: stateRecord.mcpClientId,
        userId,
        authCodePrefix: authCodeRecord.code.substring(0, 8),
        expiresAt: authCodeRecord.expiresAt,
        // Full URL logged so we can verify vscode:// deep-link format exactly.
        // NOTE: contains auth code — treat as sensitive, rotate immediately on exposure.
        redirectUrl: finalRedirectUrl,
      });

      // ── Custom-scheme redirect (vscode://, cursor://, etc.) ──────────────
      // Browsers (Chrome 91+, Safari) block plain HTTP 302 → custom-scheme
      // redirects without an explicit user gesture, causing the vscode:// URI
      // to be silently swallowed before VS Code ever receives the deep link.
      //
      // Fix: serve an HTML page that uses window.location.href (page-level
      // navigation; browsers allow this) and shows a manual button fallback.
      // The page also shows a "close this tab" message after the redirect so
      // the user knows the flow completed.
      const isCustomScheme = redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:';

      if (isCustomScheme) {
        const safeFinalUrl = htmlEscape(finalRedirectUrl);
        res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Opening in VS Code…</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 80px auto; text-align: center; line-height: 1.6; color: #111827; padding: 0 16px; }
      .btn { display: inline-block; background: #111827; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 10px; font-size: 1rem; margin-top: 20px; }
      .btn:hover { background: #1f2937; }
      .muted { color: #6b7280; font-size: .9rem; margin-top: 24px; }
    </style>
  </head>
  <body>
    <h2>eBay authentication complete ✓</h2>
    <p>Opening VS Code to finish connecting…</p>
    <a class="btn" href="${safeFinalUrl}" id="open-link">Open in VS Code</a>
    <p class="muted">If VS Code does not open automatically, click the button above.<br>You may close this tab once VS Code activates.</p>
    <script>
      // Give the page a moment to render, then navigate.
      // window.location.href (user-initiated via script on page load) is
      // allowed by Chrome/Safari for custom URI schemes.
      setTimeout(function() {
        window.location.href = ${JSON.stringify(finalRedirectUrl)};
      }, 300);
    </script>
  </body>
</html>`);
        return;
      }

      // For http:// / https:// redirect URIs (e.g. localhost loopback), a
      // plain 302 is fine and is the standard OAuth response.
      res.redirect(finalRedirectUrl);
      return;
    }

    // ── Non-MCP flow: show tokens page ────────────────────────────────────
    serverLogger.info('[oauth/callback] Non-MCP flow: creating hosted session', { userId });
    const session = await authStore.createSession(userId, environment);
    const serverBearer = await authStore.createServerBearerToken(userId, environment);

    res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>eBay MCP Connected</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; max-width: 760px; margin: 40px auto; line-height: 1.5; padding: 0 16px; }
      .card { background: #f7f7f8; padding: 16px; border-radius: 10px; margin: 16px 0; }
      pre { white-space: pre-wrap; word-break: break-all; background: #fff; padding: 14px; border-radius: 8px; border: 1px solid #e5e7eb; }
      .copy-btn { background: #111827; color: white; border: none; border-radius: 8px; padding: 10px 14px; cursor: pointer; transition: transform 120ms ease, opacity 120ms ease, background 120ms ease; }
      .copy-btn:hover { background: #1f2937; }
      .copy-btn:active { transform: scale(0.97); opacity: 0.92; }
      .copy-status { margin-left: 12px; color: #065f46; font-weight: 600; }
      .muted { color: #6b7280; }
      a { color: #2563eb; }
    </style>
    <script src="/callback-copy.js" defer></script>
  </head>
  <body>
    <h1>eBay account connected ✓</h1>
    <p>Your <strong>${htmlEscape(environment)}</strong> account has been connected successfully.</p>
    <p>Stored token record expires: <strong>${htmlEscape(serverBearer.expiresAt)}</strong></p>

    <h2>① Server request headers — for MCP clients that support custom headers</h2>
    <div class="card">
      <pre id="server-headers">X-Ebay-Server-Request: true
X-Ebay-Client-Id: ${htmlEscape(ebayConfig.clientId)}
X-Ebay-User-Id: ${htmlEscape(userId)}
X-Ebay-Environment: ${htmlEscape(environment)}</pre>
      <button class="copy-btn" data-copy-source="server-headers" data-copy-status="sh-status">Copy</button><span id="sh-status" class="copy-status"></span>
      <p class="muted">These headers select the stored Redis/KV user token record directly and do not require a hosted session token.</p>
    </div>

    <h2>② Bearer token — for MCP clients that support Authorization headers</h2>
    <div class="card">
      <pre id="server-bearer">Authorization: Bearer ${htmlEscape(serverBearer.token)}</pre>
      <button class="copy-btn" data-copy-source="server-bearer" data-copy-status="sb-status">Copy</button><span id="sb-status" class="copy-status"></span>
      <p class="muted">This server-issued token maps to the same stored user token record. It expires with the eBay refresh token.</p>
    </div>

    <h2>③ Legacy hosted session token</h2>
    <div class="card">
      <pre id="session-token">${htmlEscape(session.sessionToken)}</pre>
      <button class="copy-btn" data-copy-source="session-token" data-copy-status="st-status">Copy</button><span id="st-status" class="copy-status"></span>
      <p class="muted">Kept for backward compatibility with the older hosted session flow. Prefer the server headers or server bearer token above.</p>
    </div>

    <h2>④ eBay user access token</h2>
    <div class="card">
      <pre id="access-token">${htmlEscape(tokenData.access_token)}</pre>
      <button class="copy-btn" data-copy-source="access-token" data-copy-status="at-status">Copy</button><span id="at-status" class="copy-status"></span>
      <p class="muted">Set as <code>EBAY_USER_ACCESS_TOKEN</code> in your server env (optional — auto-refreshed from refresh token).</p>
    </div>

    <h2>⑤ eBay user refresh token</h2>
    <div class="card">
      <pre id="refresh-token">${htmlEscape(tokenData.refresh_token ?? '')}</pre>
      <button class="copy-btn" data-copy-source="refresh-token" data-copy-status="rt-status">Copy</button><span id="rt-status" class="copy-status"></span>
      <p class="muted">Set as <code>EBAY_USER_REFRESH_TOKEN</code> in your server env. The server uses this to keep the access token fresh automatically.</p>
    </div>

    <div class="card">
      <p><strong>Recommended MCP client server-request configuration:</strong></p>
      <pre>headers:
  X-Ebay-Server-Request: "true"
  X-Ebay-Client-Id: "${htmlEscape(ebayConfig.clientId)}"
  X-Ebay-User-Id: "${htmlEscape(userId)}"
  X-Ebay-Environment: "${htmlEscape(environment)}"</pre>
    </div>

    <p><strong>MCP endpoints:</strong></p>
    <ul>
      <li>Sandbox: <code>${htmlEscape(`${serverUrl}/sandbox/mcp`)}</code></li>
      <li>Production: <code>${htmlEscape(`${serverUrl}/production/mcp`)}</code></li>
    </ul>
    <p><strong>Scopes granted:</strong> ${htmlEscape(tokenData.scope ?? 'Not returned by eBay in token response')}</p>
    <p class="muted">Keep these tokens private. Refresh tokens are valid for ~18 months.</p>
  </body>
</html>`);
  } catch (error) {
    serverLogger.error('[oauth/callback] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res
      .status(500)
      .send(
        `<h1>OAuth callback failed</h1><pre>${htmlEscape(error instanceof Error ? error.message : String(error))}</pre>`
      );
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  try {
    const app = createApp();

    const certPath = process.env.EBAY_LOCAL_TLS_CERT_PATH;
    const keyPath = process.env.EBAY_LOCAL_TLS_KEY_PATH;
    const localTlsEligible = isLocalDevelopmentBaseUrl(CONFIG.publicBaseUrl);
    const useHttps =
      CONFIG.publicBaseUrl.startsWith('https://') && localTlsEligible && !!certPath && !!keyPath;

    const serverUrl = getServerBaseUrl();

    serverLogger.info('[startup] Public OAuth URL diagnostics', {
      publicBaseUrl: CONFIG.publicBaseUrl || '(unset)',
      serverUrl,
      expectedCallbackUrl: getExpectedOAuthCallbackUrl(serverUrl),
      localTlsEligible,
      hasLocalTlsCertPath: !!certPath,
      hasLocalTlsKeyPath: !!keyPath,
      useHttps,
    });

    if (CONFIG.publicBaseUrl.startsWith('https://') && !localTlsEligible && (certPath || keyPath)) {
      serverLogger.warn('[startup] Ignoring local TLS certificate settings for hosted base URL', {
        publicBaseUrl: CONFIG.publicBaseUrl,
        hasLocalTlsCertPath: !!certPath,
        hasLocalTlsKeyPath: !!keyPath,
      });
    }

    const onListening = (): void => {
      const protocol = useHttps ? 'HTTPS' : 'HTTP';
      console.log(`Server running at ${serverUrl} [${protocol}]`);
      console.log(`OAuth callback:  ${getExpectedOAuthCallbackUrl(serverUrl)}`);
      console.log(`MCP (default):    ${serverUrl}/mcp`);
      console.log(`MCP (sandbox):    ${serverUrl}/sandbox/mcp`);
      console.log(`MCP (production): ${serverUrl}/production/mcp`);
      console.log(`OAuth (sandbox):  ${serverUrl}/sandbox/oauth/start`);
      console.log(`OAuth (prod):     ${serverUrl}/production/oauth/start`);
      console.log(`Validation Research:       ${serverUrl}/validation/run`);
      console.log(
        `Internal eBay Research session expiry check: ${serverUrl}/internal/ebay-research/check-session-expiry`
      );
    };

    let server: ReturnType<typeof app.listen>;

    if (useHttps) {
      let cert: Buffer;
      let key: Buffer;
      try {
        cert = readFileSync(certPath);
        key = readFileSync(keyPath);
      } catch (err) {
        console.error(
          `Fatal: could not read TLS cert/key files — ` +
            `EBAY_LOCAL_TLS_CERT_PATH=${certPath}, EBAY_LOCAL_TLS_KEY_PATH=${keyPath}\n`,
          err
        );
        throw err;
      }
      const httpsServer = createHttpsServer({ cert, key }, app);
      server = httpsServer.listen(CONFIG.port, CONFIG.host, onListening);
    } else {
      server = app.listen(CONFIG.port, CONFIG.host, onListening);
    }

    process.on('SIGINT', () => {
      server.close(() => {
        process.exitCode = 0;
        process.kill(process.pid, 'SIGTERM');
      });
    });
  } catch (error) {
    console.error('Fatal error starting server:', error);
    throw error;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (entryPath && modulePath === entryPath) {
  await main();
}
