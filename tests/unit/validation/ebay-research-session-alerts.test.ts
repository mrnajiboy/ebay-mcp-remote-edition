/// <reference types="node" />

declare const process: {
  env: Record<string, string | undefined>;
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const axiosPostMock = vi.fn();
const kvGetMock = vi.fn();
const kvPutMock = vi.fn();
const kvPutIfAbsentMock = vi.fn();
const kvDeleteMock = vi.fn();
const createFreshKvStoreForBackendMock = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: axiosPostMock,
    isAxiosError: () => false,
  },
  isAxiosError: () => false,
}));

vi.mock('@/auth/kv-store.js', () => {
  const mockStore = {
    backendName: 'memory',
    get: kvGetMock,
    put: kvPutMock,
    putIfAbsent: kvPutIfAbsentMock,
    delete: kvDeleteMock,
  };

  return {
    createKVStore: () => mockStore,
    createKVStoreForBackend: () => mockStore,
    createFreshKVStoreForBackend: (...args: unknown[]) => createFreshKvStoreForBackendMock(...args),
  };
});

function createQStashSignature(options: {
  body: string;
  url: string;
  signingKey: string;
  nowSeconds?: number;
}): string {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'Upstash',
      sub: options.url,
      nbf: nowSeconds - 30,
      exp: nowSeconds + 300,
      body: createHash('sha256').update(options.body).digest('base64url'),
    })
  ).toString('base64url');
  const signature = createHmac('sha256', options.signingKey)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('ebay research session alerts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T09:00:00.000Z'));
    axiosPostMock.mockReset();
    kvGetMock.mockReset();
    kvPutMock.mockReset();
    kvPutIfAbsentMock.mockReset();
    kvDeleteMock.mockReset();
    createFreshKvStoreForBackendMock.mockReset();
    kvPutIfAbsentMock.mockResolvedValue(true);
    createFreshKvStoreForBackendMock.mockImplementation(() => ({
      backendName: 'memory',
      get: kvGetMock,
      put: kvPutMock,
      putIfAbsent: kvPutIfAbsentMock,
      delete: kvDeleteMock,
    }));

    process.env.PUBLIC_BASE_URL = 'https://ebay-mcp.thousandstory.fyi';
    process.env.QSTASH_URL = 'https://qstash.upstash.io';
    process.env.QSTASH_TOKEN = 'qstash-token';
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'current-signing-key';
    process.env.QSTASH_NEXT_SIGNING_KEY = 'next-signing-key';
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-bot-token';
    process.env.TELEGRAM_CHAT_ID = '1574052684';
    process.env.EBAY_RESEARCH_SESSION_STORE = 'upstash-redis';
    process.env.EBAY_ENVIRONMENT = 'production';
    process.env.EBAY_RESEARCH_SESSION_ALERTS_ENABLED = 'true';
    process.env.EBAY_RESEARCH_SESSION_ALERT_WINDOW_24H = 'true';
    process.env.EBAY_RESEARCH_SESSION_ALERT_WINDOW_6H = 'true';
    process.env.EBAY_RESEARCH_SESSION_ALERT_ON_EXPIRED = 'true';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL;
    delete process.env.QSTASH_URL;
    delete process.env.QSTASH_TOKEN;
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.EBAY_RESEARCH_SESSION_STORE;
    delete process.env.EBAY_ENVIRONMENT;
    delete process.env.EBAY_RESEARCH_SESSION_ALERTS_ENABLED;
    delete process.env.EBAY_RESEARCH_SESSION_ALERT_WINDOW_24H;
    delete process.env.EBAY_RESEARCH_SESSION_ALERT_WINDOW_6H;
    delete process.env.EBAY_RESEARCH_SESSION_ALERT_ON_EXPIRED;
  });

  it('schedules 24h, 6h, and expiry QStash callbacks', async () => {
    axiosPostMock.mockResolvedValue({ status: 200, data: { messageId: 'msg-1' } });

    const { scheduleEbayResearchSessionAlerts } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('scheduled');
    expect(result.scheduled).toHaveLength(3);
    expect(axiosPostMock).toHaveBeenCalledTimes(3);
    expect(axiosPostMock.mock.calls[0]?.[0]).toBe(
      'https://qstash.upstash.io/v2/publish/https://ebay-mcp.thousandstory.fyi/internal/ebay-research/check-session-expiry'
    );
    expect(axiosPostMock.mock.calls[0]?.[2]?.headers?.Authorization).toBe('Bearer qstash-token');
    expect(axiosPostMock.mock.calls[0]?.[1]).toMatchObject({
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });
  });

  it('skips scheduling when the runtime cannot verify or deliver alerts', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;

    const { scheduleEbayResearchSessionAlerts } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('alert_runtime_not_configured');
    expect(result.scheduled).toHaveLength(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('skips scheduling when the configured session store cannot provide shared locks', async () => {
    process.env.EBAY_RESEARCH_SESSION_STORE = 'cloudflare_kv';

    const { scheduleEbayResearchSessionAlerts } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('shared_lock_backend_unavailable');
    expect(result.scheduled).toHaveLength(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('skips scheduling when the callback URL is not publicly reachable', async () => {
    delete process.env.PUBLIC_BASE_URL;

    const { scheduleEbayResearchSessionAlerts } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('callback_url_not_public');
    expect(result.scheduled).toHaveLength(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('skips scheduling when the callback URL uses a private IP literal', async () => {
    process.env.EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL =
      'http://192.168.1.50:3000/internal/ebay-research/check-session-expiry';

    const { scheduleEbayResearchSessionAlerts } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('callback_url_not_public');
    expect(result.scheduled).toHaveLength(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('skips scheduling when the callback URL uses a private IPv6 literal', async () => {
    process.env.EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL =
      'https://[fd12:3456:789a::1]/internal/ebay-research/check-session-expiry';

    const { scheduleEbayResearchSessionAlerts } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('callback_url_not_public');
    expect(result.scheduled).toHaveLength(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('ignores stale reminder callbacks when session version changed', async () => {
    kvGetMock.mockImplementation(async (key?: string) => {
      if (key === 'ebay_research_storage_state_json') {
        return JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-a' }], origins: [] });
      }
      if (key === 'ebay_research_storage_state_meta') {
        return {
          updatedAt: '2026-04-14T08:00:00.000Z',
          expiresAt: '2026-04-20T15:13:57.239Z',
          sessionVersion: '2026-04-14T08:00:00.000Z',
          marketplace: 'EBAY-US',
          sessionStore: 'upstash-redis',
        };
      }
      return null;
    });

    const { evaluateEbayResearchSessionExpiryCheck } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('session_version_mismatch');
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('treats session-store initialization failures as infrastructure errors instead of missing-session alerts', async () => {
    createFreshKvStoreForBackendMock.mockImplementation(() => {
      throw new Error('simulated store bootstrap failure');
    });

    const { evaluateEbayResearchSessionExpiryCheck } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('error');
    expect(result.reason).toBe('session_store_unavailable');
    expect(result.message).toContain('simulated store bootstrap failure');
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(kvDeleteMock).not.toHaveBeenCalled();
  });

  it('sends telegram alert when callback threshold is reached', async () => {
    let storedMeta: Record<string, unknown> | null = {
      updatedAt: '2026-04-13T15:13:57.239Z',
      expiresAt: '2026-04-14T12:00:00.000Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
      marketplace: 'EBAY-US',
      sessionStore: 'upstash-redis',
      storeTtlSeconds: 179 * 24 * 60 * 60,
    };

    kvGetMock.mockImplementation(async (key?: string) => {
      if (key === 'ebay_research_storage_state_json') {
        return JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-a' }], origins: [] });
      }
      if (key === 'ebay_research_storage_state_meta') {
        return storedMeta;
      }
      return null;
    });
    kvPutMock.mockImplementation(async (key: string, value: unknown) => {
      if (key === 'ebay_research_storage_state_meta' && typeof value === 'object' && value !== null) {
        storedMeta = value as Record<string, unknown>;
      }
    });
    axiosPostMock.mockResolvedValue({ status: 200, data: { ok: true } });

    const { evaluateEbayResearchSessionExpiryCheck } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '6h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('alerted');
    expect(result.alertType).toBe('warning_6h');
    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottelegram-bot-token/sendMessage',
      expect.objectContaining({
        chat_id: '1574052684',
      }),
      expect.any(Object)
    );

    const duplicateResult = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '6h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(duplicateResult.status).toBe('ignored');
    expect(duplicateResult.reason).toBe('duplicate_alert');
    expect(axiosPostMock).toHaveBeenCalledTimes(1);
  });

  it('releases the shared alert lock when telegram delivery fails so a retry can alert later', async () => {
    let storedMeta: Record<string, unknown> | null = {
      updatedAt: '2026-04-13T15:13:57.239Z',
      expiresAt: '2026-04-14T12:00:00.000Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
      marketplace: 'EBAY-US',
      sessionStore: 'upstash-redis',
      storeTtlSeconds: 179 * 24 * 60 * 60,
    };

    kvGetMock.mockImplementation(async (key?: string) => {
      if (key === 'ebay_research_storage_state_json') {
        return JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-a' }], origins: [] });
      }
      if (key === 'ebay_research_storage_state_meta') {
        return storedMeta;
      }
      return null;
    });
    kvPutMock.mockImplementation(async (key: string, value: unknown) => {
      if (key === 'ebay_research_storage_state_meta' && typeof value === 'object' && value !== null) {
        storedMeta = value as Record<string, unknown>;
      }
    });
    axiosPostMock
      .mockRejectedValueOnce(new Error('telegram unavailable'))
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });

    const { evaluateEbayResearchSessionExpiryCheck } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const firstResult = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '6h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(firstResult.status).toBe('error');
    expect(firstResult.reason).toBe('telegram_delivery_failed');
    expect(kvDeleteMock).toHaveBeenCalledWith(
      'ebay_research_storage_state_meta:alert-lock:6h:2026-04-13T15:13:57.239Z'
    );

    const secondResult = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '6h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(secondResult.status).toBe('alerted');
    expect(secondResult.reason).toBe('threshold_reached');
    expect(axiosPostMock).toHaveBeenCalledTimes(2);
  });

  it('re-checks fresh metadata after claiming the alert and suppresses stale callbacks', async () => {
    let metaReads = 0;
    kvGetMock.mockImplementation(async (key?: string) => {
      if (key === 'ebay_research_storage_state_json') {
        return JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-a' }], origins: [] });
      }
      if (key === 'ebay_research_storage_state_meta') {
        metaReads += 1;
        return metaReads === 1
          ? {
              updatedAt: '2026-04-13T15:13:57.239Z',
              expiresAt: '2026-04-14T12:00:00.000Z',
              sessionVersion: '2026-04-13T15:13:57.239Z',
              marketplace: 'EBAY-US',
              sessionStore: 'upstash-redis',
              storeTtlSeconds: 179 * 24 * 60 * 60,
            }
          : {
              updatedAt: '2026-04-14T09:30:00.000Z',
              expiresAt: '2026-04-21T12:00:00.000Z',
              sessionVersion: '2026-04-14T09:30:00.000Z',
              marketplace: 'EBAY-US',
              sessionStore: 'upstash-redis',
              storeTtlSeconds: 179 * 24 * 60 * 60,
            };
      }
      return null;
    });

    const { evaluateEbayResearchSessionExpiryCheck } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const result = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '6h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('session_version_mismatch');
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(kvPutMock).not.toHaveBeenCalledWith(
      'ebay_research_storage_state_meta',
      expect.anything(),
      expect.anything()
    );
  });

  it('deduplicates missing-session alerts across repeated callback deliveries', async () => {
    const claimedLocks = new Set<string>();
    kvGetMock.mockResolvedValue(null);
    kvPutIfAbsentMock.mockImplementation(async (key: string) => {
      if (claimedLocks.has(key)) {
        return false;
      }

      claimedLocks.add(key);
      return true;
    });
    axiosPostMock.mockResolvedValue({ status: 200, data: { ok: true } });

    const { evaluateEbayResearchSessionExpiryCheck } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const firstResult = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    const secondResult = await evaluateEbayResearchSessionExpiryCheck({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(firstResult.status).toBe('alerted');
    expect(firstResult.reason).toBe('session_missing');
    expect(secondResult.status).toBe('ignored');
    expect(secondResult.reason).toBe('duplicate_alert');
    expect(axiosPostMock).toHaveBeenCalledTimes(1);
  });

  it('stores session metadata ttl separately from long-lived KV retention', async () => {
    const metaWrites: unknown[] = [];
    kvPutMock.mockImplementation(async (_key: string, value: unknown) => {
      metaWrites.push(value);
    });

    const { storeEbayResearchSessionToKv } = await import(
      '../../../src/validation/providers/ebay-research.js'
    );

    await storeEbayResearchSessionToKv(
      'EBAY-US',
      {
        cookies: [
          {
            name: 'sid',
            value: 'cookie-a',
            domain: '.ebay.com',
            path: '/',
            expires: Math.floor(Date.parse('2026-04-20T15:13:57.239Z') / 1000),
          },
        ],
        origins: [],
      },
      'storage_state'
    );

    expect(kvPutMock).toHaveBeenCalledWith(
      'ebay_research_storage_state_json',
      expect.any(String),
      179 * 24 * 60 * 60
    );
    expect(kvPutMock).toHaveBeenCalledWith(
      'ebay_research_storage_state_meta',
      expect.objectContaining({
        expiresAt: '2026-04-20T15:13:57.000Z',
        ttlSeconds: expect.any(Number),
        storeTtlSeconds: 179 * 24 * 60 * 60,
      }),
      179 * 24 * 60 * 60
    );

    const metaWrite = metaWrites.find(
      (value) => typeof value === 'object' && value !== null && 'sessionVersion' in value
    ) as { ttlSeconds: number } | undefined;
    expect(metaWrite?.ttlSeconds).toBeLessThan(179 * 24 * 60 * 60);
  });

  it('cleans up stale filesystem alert locks on session rotation and delete', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ebay-research-alerts-'));
    process.env.EBAY_RESEARCH_STORAGE_STATE_PATH = join(tempDir, 'storage-state.json');

    try {
      const { FilesystemSessionStore } = await import(
        '../../../src/validation/providers/ebay-research-session-store.js'
      );

      const store = new FilesystemSessionStore();
      const old24hLockPath = `${store.metaKey}.alert-lock.${createHash('sha256')
        .update('24h:old-session-version')
        .digest('hex')
        .slice(0, 24)}.json`;
      const old6hLockPath = `${store.metaKey}.alert-lock.${createHash('sha256')
        .update('6h:old-session-version')
        .digest('hex')
        .slice(0, 24)}.json`;
      const currentLockPath = `${store.metaKey}.alert-lock.${createHash('sha256')
        .update('expired:current-session-version')
        .digest('hex')
        .slice(0, 24)}.json`;

      expect(await store.tryAcquireAlertLock('24h', 'old-session-version')).toBe(true);
      expect(await store.tryAcquireAlertLock('6h', 'old-session-version')).toBe(true);

      await store.setMeta({
        sessionVersion: 'current-session-version',
        expiresAt: '2026-04-20T15:13:57.239Z',
      });

      expect(existsSync(old24hLockPath)).toBe(false);
      expect(existsSync(old6hLockPath)).toBe(false);

      expect(await store.tryAcquireAlertLock('expired', 'current-session-version')).toBe(true);
      expect(existsSync(currentLockPath)).toBe(true);

      await store.deleteStorageState();

      expect(existsSync(currentLockPath)).toBe(false);
      expect(existsSync(store.metaKey)).toBe(false);
      expect(existsSync(store.stateKey)).toBe(false);
    } finally {
      delete process.env.EBAY_RESEARCH_STORAGE_STATE_PATH;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('verifies a valid qstash signature', async () => {
    const { verifyQStashRequestSignature } = await import(
      '../../../src/validation/providers/ebay-research-session-alerts.js'
    );

    const url = 'https://ebay-mcp.thousandstory.fyi/internal/ebay-research/check-session-expiry';
    const body = JSON.stringify({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    const signature = createQStashSignature({
      body,
      url,
      signingKey: 'current-signing-key',
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    expect(() =>
      verifyQStashRequestSignature({
        signature,
        rawBody: body,
        url,
      })
    ).not.toThrow();
  });

  it('uses the callback override consistently for scheduling and signature verification', async () => {
    process.env.EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL =
      'https://alerts.example.com/hooks/ebay-research/check-session-expiry';
    axiosPostMock.mockResolvedValue({ status: 200, data: { messageId: 'msg-override' } });

    const {
      getEbayResearchSessionAlertCallbackUrl,
      scheduleEbayResearchSessionAlerts,
      verifyQStashRequestSignature,
    } = await import('../../../src/validation/providers/ebay-research-session-alerts.js');

    const scheduleResult = await scheduleEbayResearchSessionAlerts({
      marketplace: 'EBAY-US',
      expiresAt: '2026-04-20T15:13:57.239Z',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });

    expect(scheduleResult.callbackUrl).toBe(
      'https://alerts.example.com/hooks/ebay-research/check-session-expiry'
    );
    expect(axiosPostMock.mock.calls[0]?.[0]).toBe(
      'https://qstash.upstash.io/v2/publish/https://alerts.example.com/hooks/ebay-research/check-session-expiry'
    );

    const url = getEbayResearchSessionAlertCallbackUrl();
    const body = JSON.stringify({
      type: 'ebay_research_session_expiry_warning',
      marketplace: 'EBAY-US',
      threshold: '24h',
      sessionVersion: '2026-04-13T15:13:57.239Z',
    });
    const signature = createQStashSignature({
      body,
      url,
      signingKey: 'current-signing-key',
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    expect(() =>
      verifyQStashRequestSignature({
        signature,
        rawBody: body,
        url,
      })
    ).not.toThrow();
  });
});
