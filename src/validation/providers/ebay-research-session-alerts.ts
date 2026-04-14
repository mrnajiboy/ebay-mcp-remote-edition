import axios from 'axios';
import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import {
  createFreshEbayResearchSessionStoreResolution,
  resolveEbayResearchSessionStoreBackend,
  type EbayResearchSessionStoreBackend,
  type EbayResearchSessionStoreMeta,
} from './ebay-research-session-store.js';
import { serverLogger } from '@/utils/logger.js';

const SESSION_ALERT_ROUTE = '/internal/ebay-research/check-session-expiry';
const HOURS_TO_MS = 60 * 60 * 1000;
const ALERT_LOCK_FALLBACK_TTL_S = 7 * 24 * 60 * 60;

export type EbayResearchSessionAlertThreshold = '24h' | '6h' | 'expired';

export interface EbayResearchSessionExpiryCheckPayload {
  type: 'ebay_research_session_expiry_warning' | 'ebay_research_session_expired';
  marketplace: string;
  threshold: EbayResearchSessionAlertThreshold;
  sessionVersion: string;
  messageType?: string;
}

export interface EbayResearchSessionAlertScheduleRequest {
  marketplace: string;
  expiresAt: string;
  sessionVersion: string;
}

interface EbayResearchSessionAlertConfig {
  enabled: boolean;
  warning24hEnabled: boolean;
  warning6hEnabled: boolean;
  expiredEnabled: boolean;
  qstashUrl: string;
  qstashToken: string;
  qstashCurrentSigningKey: string;
  qstashNextSigningKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  callbackUrl: string;
}

interface ReadCanonicalResearchSessionResult {
  storageState: string | null;
  meta: EbayResearchSessionStoreMeta | null;
  storeSelected: string;
  storeError: string | null;
}

interface TelegramDeliveryResult {
  ok: boolean;
  status: number | null;
  responseBody: unknown;
  error?: string;
}

interface QStashScheduleResult {
  threshold: EbayResearchSessionAlertThreshold;
  targetTime: string;
  messageId: string | null;
}

interface AlertRuntimeValidationResult {
  ok: boolean;
  reason?: string;
  missing: string[];
}

export interface EbayResearchSessionAlertEvaluationResult {
  status: 'alerted' | 'ignored' | 'error';
  reason?: string;
  threshold: EbayResearchSessionAlertThreshold;
  marketplace: string;
  sessionVersion: string;
  currentSessionVersion: string | null;
  expiresAt: string | null;
  remainingSeconds: number | null;
  alertType?: 'warning_24h' | 'warning_6h' | 'expired' | 'missing';
  telegram?: {
    ok: boolean;
    status: number | null;
  };
  message?: string;
}

const activeAlertEvaluations = new Set<string>();

function isTruthyEnv(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value.trim().toLowerCase() === 'true';
}

function getServerBaseUrlFromEnv(): string {
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (publicBaseUrl) {
    return publicBaseUrl;
  }

  const host = (process.env.MCP_HOST ?? 'localhost').trim() || 'localhost';
  const normalizedHost = host === '0.0.0.0' ? 'localhost' : host;
  const port = Number(process.env.PORT ?? 3000);
  return `http://${normalizedHost}:${port}`;
}

function isLoopbackOrWildcardHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function isNonPublicIpLiteral(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  const family = isIP(normalized);

  if (family === 4) {
    const octets = normalized.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
      return false;
    }

    const [first, second] = octets;
    return (
      first === 10 ||
      first === 127 ||
      first === 0 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }

  if (family === 6) {
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }

  return false;
}

function validateCallbackUrlForScheduling(callbackUrl: string): AlertRuntimeValidationResult {
  let parsed: URL;

  try {
    parsed = new URL(callbackUrl);
  } catch {
    return {
      ok: false,
      reason: 'callback_url_invalid',
      missing: [],
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      ok: false,
      reason: 'callback_url_invalid',
      missing: [],
    };
  }

  if (isLoopbackOrWildcardHostname(parsed.hostname)) {
    return {
      ok: false,
      reason: 'callback_url_not_public',
      missing: [],
    };
  }

  if (isNonPublicIpLiteral(parsed.hostname)) {
    return {
      ok: false,
      reason: 'callback_url_not_public',
      missing: [],
    };
  }

  return {
    ok: true,
    missing: [],
  };
}

export function getEbayResearchSessionAlertCallbackUrl(): string {
  const callbackOverride = process.env.EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL?.trim();
  return callbackOverride && callbackOverride.length > 0
    ? callbackOverride
    : `${getServerBaseUrlFromEnv()}${SESSION_ALERT_ROUTE}`;
}

function getAlertConfig(): EbayResearchSessionAlertConfig {
  return {
    enabled: isTruthyEnv(process.env.EBAY_RESEARCH_SESSION_ALERTS_ENABLED, true),
    warning24hEnabled: isTruthyEnv(process.env.EBAY_RESEARCH_SESSION_ALERT_WINDOW_24H, true),
    warning6hEnabled: isTruthyEnv(process.env.EBAY_RESEARCH_SESSION_ALERT_WINDOW_6H, true),
    expiredEnabled: isTruthyEnv(process.env.EBAY_RESEARCH_SESSION_ALERT_ON_EXPIRED, true),
    qstashUrl: (process.env.QSTASH_URL ?? '').trim().replace(/\/$/, ''),
    qstashToken: (process.env.QSTASH_TOKEN ?? '').trim(),
    qstashCurrentSigningKey: (process.env.QSTASH_CURRENT_SIGNING_KEY ?? '').trim(),
    qstashNextSigningKey: (process.env.QSTASH_NEXT_SIGNING_KEY ?? '').trim(),
    telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    telegramChatId: (process.env.TELEGRAM_CHAT_ID ?? '').trim(),
    callbackUrl: getEbayResearchSessionAlertCallbackUrl(),
  };
}

function getThresholdMs(threshold: EbayResearchSessionAlertThreshold): number {
  switch (threshold) {
    case '24h':
      return 24 * HOURS_TO_MS;
    case '6h':
      return 6 * HOURS_TO_MS;
    case 'expired':
    default:
      return 0;
  }
}

function supportsSharedAlertLocks(backend: EbayResearchSessionStoreBackend): boolean {
  return backend === 'upstash-redis' || backend === 'filesystem';
}

function buildAlertMarkerKey(payload: {
  marketplace: string;
  threshold: EbayResearchSessionAlertThreshold;
  sessionVersion: string;
}): string {
  return `${payload.marketplace}:${payload.threshold}:${payload.sessionVersion}`;
}

function getAlertMarkerTimestamp(
  meta: EbayResearchSessionStoreMeta | null,
  threshold: EbayResearchSessionAlertThreshold
): string | null {
  if (!meta || typeof meta.alertsSentAt !== 'object' || meta.alertsSentAt === null) {
    return null;
  }

  const value = meta.alertsSentAt[threshold];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getAlertMarkerTtlSeconds(
  meta: EbayResearchSessionStoreMeta | null,
  expiresAtMs: number | null
): number | undefined {
  if (typeof meta?.storeTtlSeconds === 'number' && Number.isFinite(meta.storeTtlSeconds)) {
    return meta.storeTtlSeconds;
  }

  if (typeof meta?.ttlSeconds === 'number' && Number.isFinite(meta.ttlSeconds)) {
    return meta.ttlSeconds;
  }

  if (expiresAtMs !== null) {
    return Math.max(60, Math.ceil((expiresAtMs - Date.now()) / 1000) + 24 * 60 * 60);
  }

  return ALERT_LOCK_FALLBACK_TTL_S;
}

function validateAlertRuntimeConfig(
  config: EbayResearchSessionAlertConfig
): AlertRuntimeValidationResult {
  const missing: string[] = [];

  if (!config.qstashUrl) {
    missing.push('QSTASH_URL');
  }
  if (!config.qstashToken) {
    missing.push('QSTASH_TOKEN');
  }
  if (!config.qstashCurrentSigningKey) {
    missing.push('QSTASH_CURRENT_SIGNING_KEY');
  }
  if (!config.qstashNextSigningKey) {
    missing.push('QSTASH_NEXT_SIGNING_KEY');
  }
  if (!config.telegramBotToken) {
    missing.push('TELEGRAM_BOT_TOKEN');
  }
  if (!config.telegramChatId) {
    missing.push('TELEGRAM_CHAT_ID');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'alert_runtime_not_configured',
      missing,
    };
  }

  const callbackValidation = validateCallbackUrlForScheduling(config.callbackUrl);
  if (!callbackValidation.ok) {
    return callbackValidation;
  }

  return {
    ok: true,
    missing: [],
  };
}

function getScheduledType(
  threshold: EbayResearchSessionAlertThreshold
): EbayResearchSessionExpiryCheckPayload['type'] {
  return threshold === 'expired'
    ? 'ebay_research_session_expired'
    : 'ebay_research_session_expiry_warning';
}

function getCurrentSessionVersion(meta: EbayResearchSessionStoreMeta | null): string | null {
  if (!meta) {
    return null;
  }

  if (typeof meta.sessionVersion === 'string' && meta.sessionVersion.length > 0) {
    return meta.sessionVersion;
  }

  if (typeof meta.updatedAt === 'string' && meta.updatedAt.length > 0) {
    return meta.updatedAt;
  }

  return null;
}

function getExpiryTimestamp(meta: EbayResearchSessionStoreMeta | null): number | null {
  if (!meta || typeof meta.expiresAt !== 'string' || meta.expiresAt.length === 0) {
    return null;
  }

  const expiresAtMs = Date.parse(meta.expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
}

function buildTelegramMessage(options: {
  marketplace: string;
  alertType: 'warning_24h' | 'warning_6h' | 'expired' | 'missing';
}): string {
  switch (options.alertType) {
    case 'warning_24h':
      return [
        '⚠️ eBay Research session warning',
        '',
        `Marketplace: ${options.marketplace}`,
        'Status: Expires in less than 24 hours',
        'Action: Re-bootstrap recommended',
      ].join('\n');
    case 'warning_6h':
      return [
        '⚠️ eBay Research session urgent warning',
        '',
        `Marketplace: ${options.marketplace}`,
        'Status: Expires in less than 6 hours',
        'Action: Refresh urgently to avoid first-party provider fallback',
      ].join('\n');
    case 'expired':
    case 'missing':
    default:
      return [
        '❌ eBay Research session unavailable',
        '',
        `Marketplace: ${options.marketplace}`,
        'Status: Missing or expired',
        'Impact: Validation backend may fall back to weaker providers',
        'Action: Run research bootstrap immediately',
      ].join('\n');
  }
}

async function sendTelegramAlert(
  message: string,
  marketplace: string
): Promise<TelegramDeliveryResult> {
  const config = getAlertConfig();

  if (!config.telegramBotToken || !config.telegramChatId) {
    serverLogger.error('[eBayResearchSessionAlerts] Telegram configuration is missing', {
      marketplace,
      hasTelegramBotToken: Boolean(config.telegramBotToken),
      hasTelegramChatId: Boolean(config.telegramChatId),
    });
    return {
      ok: false,
      status: null,
      responseBody: null,
      error: 'telegram configuration missing',
    };
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    const response = await axios.post(
      url,
      {
        chat_id: config.telegramChatId,
        text: message,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    serverLogger.info('[eBayResearchSessionAlerts] Telegram delivery succeeded', {
      marketplace,
      alertType: message.split('\n')[0],
      chatId: config.telegramChatId,
      status: response.status,
    });

    return {
      ok: true,
      status: response.status,
      responseBody: response.data,
    };
  } catch (error) {
    const status = axios.isAxiosError(error) ? (error.response?.status ?? null) : null;
    const responseBody = axios.isAxiosError(error) ? (error.response?.data ?? null) : null;
    const messageText = error instanceof Error ? error.message : String(error);

    serverLogger.error('[eBayResearchSessionAlerts] Telegram delivery failed', {
      marketplace,
      alertType: message.split('\n')[0],
      chatId: config.telegramChatId,
      status,
      responseBody,
      error: messageText,
    });

    return {
      ok: false,
      status,
      responseBody,
      error: messageText,
    };
  }
}

async function readCanonicalResearchSession(
  marketplace: string
): Promise<ReadCanonicalResearchSessionResult> {
  const resolution = createFreshEbayResearchSessionStoreResolution(marketplace);

  if (!resolution.store) {
    return {
      storageState: null,
      meta: null,
      storeSelected: resolution.selected,
      storeError: resolution.error,
    };
  }

  const [storageState, meta] = await Promise.all([
    resolution.store.getStorageState(),
    resolution.store.getMeta(),
  ]);

  return {
    storageState,
    meta,
    storeSelected: resolution.selected,
    storeError: resolution.error,
  };
}

async function persistAlertMarker(options: {
  marketplace: string;
  threshold: EbayResearchSessionAlertThreshold;
  sessionVersion: string;
  expiresAtMs: number | null;
}): Promise<{
  persisted: boolean;
  currentSessionVersion: string | null;
}> {
  const resolution = createFreshEbayResearchSessionStoreResolution(options.marketplace);
  if (!resolution.store) {
    throw new Error(
      resolution.error
        ? `Alert marker store unavailable (${resolution.error})`
        : `Alert marker store unavailable for backend=${resolution.selected}`
    );
  }

  const latestMeta = await resolution.store.getMeta();
  const currentSessionVersion = getCurrentSessionVersion(latestMeta);
  if (!latestMeta || currentSessionVersion !== options.sessionVersion) {
    serverLogger.info(
      '[eBayResearchSessionAlerts] Skipped alert marker write for stale session version',
      {
        marketplace: options.marketplace,
        threshold: options.threshold,
        payloadSessionVersion: options.sessionVersion,
        currentSessionVersion,
      }
    );
    return {
      persisted: false,
      currentSessionVersion,
    };
  }

  const alertsSentAt =
    typeof latestMeta.alertsSentAt === 'object' && latestMeta.alertsSentAt !== null
      ? latestMeta.alertsSentAt
      : {};

  await resolution.store.setMeta(
    {
      ...latestMeta,
      alertsSentAt: {
        ...alertsSentAt,
        [options.threshold]: new Date().toISOString(),
      },
    },
    {
      ttlSeconds: getAlertMarkerTtlSeconds(latestMeta, options.expiresAtMs),
    }
  );

  return {
    persisted: true,
    currentSessionVersion,
  };
}

export async function scheduleEbayResearchSessionAlerts(
  request: EbayResearchSessionAlertScheduleRequest
): Promise<{
  status: 'scheduled' | 'skipped';
  reason?: string;
  callbackUrl: string;
  scheduled: QStashScheduleResult[];
}> {
  const config = getAlertConfig();

  if (!config.enabled) {
    return {
      status: 'skipped',
      reason: 'alerts_disabled',
      callbackUrl: config.callbackUrl,
      scheduled: [],
    };
  }

  const runtimeValidation = validateAlertRuntimeConfig(config);
  if (!runtimeValidation.ok) {
    serverLogger.warn(
      '[eBayResearchSessionAlerts] Alert runtime is not fully configured; skipping scheduling',
      {
        marketplace: request.marketplace,
        sessionVersion: request.sessionVersion,
        missing: runtimeValidation.missing,
      }
    );
    return {
      status: 'skipped',
      reason: runtimeValidation.reason,
      callbackUrl: config.callbackUrl,
      scheduled: [],
    };
  }

  const sessionStoreBackend = resolveEbayResearchSessionStoreBackend().selected;
  if (!supportsSharedAlertLocks(sessionStoreBackend)) {
    serverLogger.warn(
      '[eBayResearchSessionAlerts] Session store backend does not support shared alert locks; skipping scheduling',
      {
        marketplace: request.marketplace,
        sessionVersion: request.sessionVersion,
        sessionStoreBackend,
      }
    );
    return {
      status: 'skipped',
      reason: 'shared_lock_backend_unavailable',
      callbackUrl: config.callbackUrl,
      scheduled: [],
    };
  }

  const expiresAtMs = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(
      `Cannot schedule eBay Research alerts with invalid expiresAt=${request.expiresAt}`
    );
  }

  const thresholds: EbayResearchSessionAlertThreshold[] = [];
  if (config.warning24hEnabled) {
    thresholds.push('24h');
  }
  if (config.warning6hEnabled) {
    thresholds.push('6h');
  }
  if (config.expiredEnabled) {
    thresholds.push('expired');
  }

  const scheduled: QStashScheduleResult[] = [];
  const now = Date.now();

  for (const threshold of thresholds) {
    const notBeforeMs = expiresAtMs - getThresholdMs(threshold);
    if (notBeforeMs <= now) {
      serverLogger.info('[eBayResearchSessionAlerts] Skipping past-due QStash schedule', {
        marketplace: request.marketplace,
        threshold,
        sessionVersion: request.sessionVersion,
        targetTime: new Date(notBeforeMs).toISOString(),
      });
      continue;
    }

    const body: EbayResearchSessionExpiryCheckPayload = {
      type: getScheduledType(threshold),
      marketplace: request.marketplace,
      threshold,
      sessionVersion: request.sessionVersion,
    };

    const publishUrl = `${config.qstashUrl}/v2/publish/${config.callbackUrl}`;
    const response = await axios.post(publishUrl, body, {
      headers: {
        Authorization: `Bearer ${config.qstashToken}`,
        'Content-Type': 'application/json',
        'Upstash-Not-Before': String(Math.floor(notBeforeMs / 1000)),
      },
      timeout: 15000,
    });

    scheduled.push({
      threshold,
      targetTime: new Date(notBeforeMs).toISOString(),
      messageId:
        typeof response.data?.messageId === 'string'
          ? response.data.messageId
          : typeof response.data?.messageID === 'string'
            ? response.data.messageID
            : null,
    });
  }

  const scheduledByThreshold = Object.fromEntries(
    scheduled.map((entry) => [entry.threshold, entry.targetTime])
  );

  serverLogger.info('[eBayResearchSessionAlerts] Scheduled session expiry checks', {
    marketplace: request.marketplace,
    expiresAt: request.expiresAt,
    sessionVersion: request.sessionVersion,
    callbackUrl: config.callbackUrl,
    scheduledByThreshold,
  });

  return {
    status: 'scheduled',
    callbackUrl: config.callbackUrl,
    scheduled,
  };
}

function decodeQStashPayload(jwt: string): {
  iss?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  body?: string;
} {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid QStash signature token');
  }

  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
    iss?: string;
    sub?: string;
    exp?: number;
    nbf?: number;
    body?: string;
  };
}

function verifyQStashJwtWithKey(options: {
  jwt: string;
  signingKey: string;
  rawBody: string;
  url: string;
}): void {
  const parts = options.jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid QStash signature token');
  }

  const [header, payload, signature] = parts;
  const expectedSignature = createHmac('sha256', options.signingKey)
    .update(`${header}.${payload}`)
    .digest('base64url');

  if (signature !== expectedSignature) {
    throw new Error('Invalid QStash JWT signature');
  }

  const decoded = decodeQStashPayload(options.jwt);
  if (decoded.iss !== 'Upstash') {
    throw new Error(`Invalid QStash issuer: ${decoded.iss ?? 'missing'}`);
  }

  if (decoded.sub !== options.url) {
    throw new Error(`Invalid QStash subject: ${decoded.sub ?? 'missing'}`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof decoded.exp === 'number' && nowSeconds > decoded.exp) {
    throw new Error('QStash signature token has expired');
  }
  if (typeof decoded.nbf === 'number' && nowSeconds < decoded.nbf) {
    throw new Error('QStash signature token is not yet valid');
  }

  const expectedBodyHash = createHash('sha256').update(options.rawBody).digest('base64url');
  if ((decoded.body ?? '').replace(/=+$/, '') !== expectedBodyHash) {
    throw new Error('QStash body hash does not match request body');
  }
}

export function verifyQStashRequestSignature(options: {
  signature: string | null | undefined;
  rawBody: string;
  url: string;
}): void {
  const config = getAlertConfig();

  if (!options.signature) {
    throw new Error('Missing Upstash-Signature header');
  }

  if (!config.qstashCurrentSigningKey || !config.qstashNextSigningKey) {
    throw new Error('QStash signing keys are not configured');
  }

  try {
    verifyQStashJwtWithKey({
      jwt: options.signature,
      signingKey: config.qstashCurrentSigningKey,
      rawBody: options.rawBody,
      url: options.url,
    });
    return;
  } catch (currentError) {
    try {
      verifyQStashJwtWithKey({
        jwt: options.signature,
        signingKey: config.qstashNextSigningKey,
        rawBody: options.rawBody,
        url: options.url,
      });
      return;
    } catch {
      throw currentError;
    }
  }
}

export async function evaluateEbayResearchSessionExpiryCheck(
  payload: EbayResearchSessionExpiryCheckPayload
): Promise<EbayResearchSessionAlertEvaluationResult> {
  const canonical = await readCanonicalResearchSession(payload.marketplace);
  if (canonical.storeError) {
    serverLogger.error(
      '[eBayResearchSessionAlerts] Failed to load canonical session store during callback evaluation',
      {
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        payloadSessionVersion: payload.sessionVersion,
        sessionStoreBackend: canonical.storeSelected,
        storeError: canonical.storeError,
      }
    );

    return {
      status: 'error',
      reason: 'session_store_unavailable',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion: null,
      expiresAt: null,
      remainingSeconds: null,
      message: canonical.storeError,
    };
  }

  if (!supportsSharedAlertLocks(canonical.storeSelected as EbayResearchSessionStoreBackend)) {
    serverLogger.warn(
      '[eBayResearchSessionAlerts] Ignored session-expiry callback because shared alert locks are unavailable',
      {
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        payloadSessionVersion: payload.sessionVersion,
        sessionStoreBackend: canonical.storeSelected,
        storeError: canonical.storeError,
      }
    );

    return {
      status: 'ignored',
      reason: 'shared_lock_backend_unavailable',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion: null,
      expiresAt: null,
      remainingSeconds: null,
    };
  }

  const currentSessionVersion = getCurrentSessionVersion(canonical.meta);
  const expiresAtMs = getExpiryTimestamp(canonical.meta);
  const expiresAt = typeof canonical.meta?.expiresAt === 'string' ? canonical.meta.expiresAt : null;
  const alertMarkerKey = buildAlertMarkerKey(payload);

  if (currentSessionVersion !== null && payload.sessionVersion !== currentSessionVersion) {
    serverLogger.info('[eBayResearchSessionAlerts] Ignored stale session-expiry callback', {
      marketplace: payload.marketplace,
      threshold: payload.threshold,
      payloadSessionVersion: payload.sessionVersion,
      currentSessionVersion,
      alertFired: false,
    });

    return {
      status: 'ignored',
      reason: 'session_version_mismatch',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion,
      expiresAt,
      remainingSeconds: expiresAtMs === null ? null : Math.floor((expiresAtMs - Date.now()) / 1000),
    };
  }

  const existingAlertTimestamp = getAlertMarkerTimestamp(canonical.meta, payload.threshold);
  if (existingAlertTimestamp) {
    serverLogger.info('[eBayResearchSessionAlerts] Ignored duplicate session-expiry callback', {
      marketplace: payload.marketplace,
      threshold: payload.threshold,
      payloadSessionVersion: payload.sessionVersion,
      currentSessionVersion,
      alertSentAt: existingAlertTimestamp,
      alertFired: false,
    });

    return {
      status: 'ignored',
      reason: 'duplicate_alert',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion,
      expiresAt,
      remainingSeconds: expiresAtMs === null ? null : Math.floor((expiresAtMs - Date.now()) / 1000),
    };
  }

  if (activeAlertEvaluations.has(alertMarkerKey)) {
    serverLogger.info(
      '[eBayResearchSessionAlerts] Ignored concurrent duplicate session-expiry callback',
      {
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        payloadSessionVersion: payload.sessionVersion,
        currentSessionVersion,
        alertFired: false,
      }
    );

    return {
      status: 'ignored',
      reason: 'duplicate_alert_in_progress',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion,
      expiresAt,
      remainingSeconds: expiresAtMs === null ? null : Math.floor((expiresAtMs - Date.now()) / 1000),
    };
  }

  activeAlertEvaluations.add(alertMarkerKey);
  const lockTtlSeconds = getAlertMarkerTtlSeconds(canonical.meta, expiresAtMs);
  const initialRemainingSeconds =
    expiresAtMs === null ? null : Math.floor((expiresAtMs - Date.now()) / 1000);
  const lockResolution = createFreshEbayResearchSessionStoreResolution(payload.marketplace);
  let lockAcquired = false;

  if (lockResolution.error) {
    serverLogger.error(
      '[eBayResearchSessionAlerts] Failed to create fresh session store during callback evaluation',
      {
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        payloadSessionVersion: payload.sessionVersion,
        sessionStoreBackend: lockResolution.selected,
        storeError: lockResolution.error,
      }
    );

    return {
      status: 'error',
      reason: 'session_store_unavailable',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion,
      expiresAt,
      remainingSeconds: initialRemainingSeconds,
      message: lockResolution.error,
    };
  }

  try {
    if (lockResolution.store) {
      lockAcquired = await lockResolution.store.tryAcquireAlertLock(
        payload.threshold,
        payload.sessionVersion,
        { ttlSeconds: lockTtlSeconds }
      );
      if (!lockAcquired) {
        serverLogger.info(
          '[eBayResearchSessionAlerts] Ignored duplicate session-expiry callback after shared lock check',
          {
            marketplace: payload.marketplace,
            threshold: payload.threshold,
            payloadSessionVersion: payload.sessionVersion,
            currentSessionVersion,
            alertFired: false,
          }
        );

        return {
          status: 'ignored',
          reason: 'duplicate_alert',
          threshold: payload.threshold,
          marketplace: payload.marketplace,
          sessionVersion: payload.sessionVersion,
          currentSessionVersion,
          expiresAt,
          remainingSeconds: initialRemainingSeconds,
        };
      }
    }

    const latestCanonical = await readCanonicalResearchSession(payload.marketplace);
    if (latestCanonical.storeError) {
      serverLogger.error(
        '[eBayResearchSessionAlerts] Failed to reload canonical session store after shared lock check',
        {
          marketplace: payload.marketplace,
          threshold: payload.threshold,
          payloadSessionVersion: payload.sessionVersion,
          sessionStoreBackend: latestCanonical.storeSelected,
          storeError: latestCanonical.storeError,
        }
      );

      if (lockAcquired && lockResolution.store) {
        await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
        lockAcquired = false;
      }

      return {
        status: 'error',
        reason: 'session_store_unavailable',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion,
        expiresAt,
        remainingSeconds: initialRemainingSeconds,
        message: latestCanonical.storeError,
      };
    }

    const latestSessionVersion = getCurrentSessionVersion(latestCanonical.meta);
    const latestExpiresAtMs = getExpiryTimestamp(latestCanonical.meta);
    const latestExpiresAt =
      typeof latestCanonical.meta?.expiresAt === 'string' ? latestCanonical.meta.expiresAt : null;
    const latestRemainingSeconds =
      latestExpiresAtMs === null ? null : Math.floor((latestExpiresAtMs - Date.now()) / 1000);

    if (!latestCanonical.meta || !latestCanonical.storageState) {
      const telegram = await sendTelegramAlert(
        buildTelegramMessage({ marketplace: payload.marketplace, alertType: 'missing' }),
        payload.marketplace
      );

      serverLogger.warn('[eBayResearchSessionAlerts] Canonical session missing during callback', {
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        payloadSessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        storeSelected: latestCanonical.storeSelected,
        storeError: latestCanonical.storeError,
        alertFired: telegram.ok,
      });

      if (!telegram.ok) {
        if (lockAcquired && lockResolution.store) {
          await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
          lockAcquired = false;
        }

        return {
          status: 'error',
          reason: 'telegram_delivery_failed',
          threshold: payload.threshold,
          marketplace: payload.marketplace,
          sessionVersion: payload.sessionVersion,
          currentSessionVersion: latestSessionVersion,
          expiresAt: latestExpiresAt,
          remainingSeconds: null,
          message: 'telegram delivery failed',
          telegram: {
            ok: false,
            status: telegram.status,
          },
        };
      }

      return {
        status: 'alerted',
        reason: 'session_missing',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: latestExpiresAt,
        remainingSeconds: null,
        alertType: 'missing',
        telegram: {
          ok: true,
          status: telegram.status,
        },
      };
    }

    if (payload.sessionVersion !== latestSessionVersion) {
      serverLogger.info(
        '[eBayResearchSessionAlerts] Ignored stale session-expiry callback after shared lock check',
        {
          marketplace: payload.marketplace,
          threshold: payload.threshold,
          payloadSessionVersion: payload.sessionVersion,
          currentSessionVersion: latestSessionVersion,
          alertFired: false,
        }
      );

      return {
        status: 'ignored',
        reason: 'session_version_mismatch',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: latestExpiresAt ?? expiresAt ?? null,
        remainingSeconds: latestRemainingSeconds,
      };
    }

    const latestAlertTimestamp = getAlertMarkerTimestamp(latestCanonical.meta, payload.threshold);
    if (latestAlertTimestamp) {
      serverLogger.info(
        '[eBayResearchSessionAlerts] Ignored duplicate session-expiry callback after fresh metadata check',
        {
          marketplace: payload.marketplace,
          threshold: payload.threshold,
          payloadSessionVersion: payload.sessionVersion,
          currentSessionVersion: latestSessionVersion,
          alertSentAt: latestAlertTimestamp,
          alertFired: false,
        }
      );

      return {
        status: 'ignored',
        reason: 'duplicate_alert',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: latestExpiresAt ?? expiresAt ?? null,
        remainingSeconds: latestRemainingSeconds,
      };
    }

    if (latestExpiresAtMs === null) {
      const telegram = await sendTelegramAlert(
        buildTelegramMessage({ marketplace: payload.marketplace, alertType: 'missing' }),
        payload.marketplace
      );

      if (!telegram.ok) {
        if (lockAcquired && lockResolution.store) {
          await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
          lockAcquired = false;
        }

        return {
          status: 'error',
          reason: 'telegram_delivery_failed',
          threshold: payload.threshold,
          marketplace: payload.marketplace,
          sessionVersion: payload.sessionVersion,
          currentSessionVersion: latestSessionVersion,
          expiresAt: latestExpiresAt,
          remainingSeconds: null,
          message: 'telegram delivery failed',
          telegram: {
            ok: false,
            status: telegram.status,
          },
        };
      }

      const markerPersistence = await persistAlertMarker({
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        sessionVersion: payload.sessionVersion,
        expiresAtMs: latestExpiresAtMs,
      });

      if (markerPersistence.persisted && lockAcquired && lockResolution.store) {
        await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
        lockAcquired = false;
      }

      return {
        status: 'alerted',
        reason: 'invalid_expiry_metadata',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: latestExpiresAt,
        remainingSeconds: null,
        alertType: 'missing',
        telegram: {
          ok: true,
          status: telegram.status,
        },
      };
    }

    const remainingMs = latestExpiresAtMs - Date.now();
    const remainingSeconds = Math.floor(remainingMs / 1000);
    const thresholdMs = getThresholdMs(payload.threshold);
    const shouldAlert =
      payload.threshold === 'expired' ? remainingMs <= 0 : remainingMs <= thresholdMs;

    if (!shouldAlert) {
      serverLogger.info('[eBayResearchSessionAlerts] Ignored not-yet-due session-expiry callback', {
        marketplace: payload.marketplace,
        threshold: payload.threshold,
        payloadSessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: new Date(latestExpiresAtMs).toISOString(),
        remainingSeconds,
        alertFired: false,
      });

      return {
        status: 'ignored',
        reason: 'threshold_not_reached',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: new Date(latestExpiresAtMs).toISOString(),
        remainingSeconds,
      };
    }

    const alertType =
      remainingMs <= 0 ? 'expired' : payload.threshold === '6h' ? 'warning_6h' : 'warning_24h';

    const telegram = await sendTelegramAlert(
      buildTelegramMessage({ marketplace: payload.marketplace, alertType }),
      payload.marketplace
    );

    serverLogger.info('[eBayResearchSessionAlerts] Evaluated session-expiry callback', {
      marketplace: payload.marketplace,
      threshold: payload.threshold,
      payloadSessionVersion: payload.sessionVersion,
      currentSessionVersion: latestSessionVersion,
      expiresAt: new Date(latestExpiresAtMs).toISOString(),
      remainingSeconds,
      alertType,
      alertFired: telegram.ok,
    });

    if (!telegram.ok) {
      if (lockAcquired && lockResolution.store) {
        await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
        lockAcquired = false;
      }

      return {
        status: 'error',
        reason: 'telegram_delivery_failed',
        threshold: payload.threshold,
        marketplace: payload.marketplace,
        sessionVersion: payload.sessionVersion,
        currentSessionVersion: latestSessionVersion,
        expiresAt: new Date(latestExpiresAtMs).toISOString(),
        remainingSeconds,
        alertType,
        message: 'telegram delivery failed',
        telegram: {
          ok: false,
          status: telegram.status,
        },
      };
    }

    const markerPersistence = await persistAlertMarker({
      marketplace: payload.marketplace,
      threshold: payload.threshold,
      sessionVersion: payload.sessionVersion,
      expiresAtMs: latestExpiresAtMs,
    });

    if (markerPersistence.persisted && lockAcquired && lockResolution.store) {
      await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
      lockAcquired = false;
    }

    if (!markerPersistence.persisted) {
      serverLogger.info(
        '[eBayResearchSessionAlerts] Telegram delivered but marker persistence was skipped for stale session version',
        {
          marketplace: payload.marketplace,
          threshold: payload.threshold,
          payloadSessionVersion: payload.sessionVersion,
          currentSessionVersion: markerPersistence.currentSessionVersion,
        }
      );
    }

    return {
      status: 'alerted',
      reason: 'threshold_reached',
      threshold: payload.threshold,
      marketplace: payload.marketplace,
      sessionVersion: payload.sessionVersion,
      currentSessionVersion: latestSessionVersion,
      expiresAt: new Date(latestExpiresAtMs).toISOString(),
      remainingSeconds,
      alertType,
      telegram: {
        ok: true,
        status: telegram.status,
      },
    };
  } catch (error) {
    if (lockAcquired && lockResolution.store) {
      await lockResolution.store.releaseAlertLock(payload.threshold, payload.sessionVersion);
    }
    throw error;
  } finally {
    activeAlertEvaluations.delete(alertMarkerKey);
  }
}
