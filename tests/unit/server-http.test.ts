import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('server-http MCP authentication', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.ADMIN_API_KEY = 'test-admin-api-key';
    process.env.EBAY_TOKEN_STORE_BACKEND = 'memory';
    process.env.PUBLIC_BASE_URL = 'https://ebay-mcp.example.test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@/validation/providers/ebay-research.js');
    vi.doUnmock('@/validation/providers/ebay-research-session-store.js');
    vi.restoreAllMocks();
  });

  it('accepts ADMIN_API_KEY as a Bearer token before looking up hosted sessions', async () => {
    const { createApp } = await import('@/server-http.js');

    const response = await request(createApp())
      .get('/production/mcp')
      .set('Authorization', 'Bearer test-admin-api-key')
      .set('Accept', 'application/json');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'invalid_session',
      error_description: 'Invalid or missing session ID',
    });
  });

  it('rejects invalid per-request server auth without redirecting to OAuth', async () => {
    const { createApp } = await import('@/server-http.js');

    const response = await request(createApp())
      .get('/production/mcp')
      .set('X-Ebay-Server-Request', 'true')
      .set('X-Ebay-Client-Id', 'missing-client')
      .set('X-Ebay-User-Id', 'missing-user')
      .set('Accept', 'application/json');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_server_request_auth');
  });

  it('starts sandbox OAuth with EBAY_SANDBOX_RUNAME when legacy REDIRECT_URI is unset', async () => {
    process.env.EBAY_SANDBOX_CLIENT_ID = 'test-sandbox-client-id';
    process.env.EBAY_SANDBOX_CLIENT_SECRET = 'test-sandbox-client-secret';
    process.env.EBAY_SANDBOX_RUNAME = 'Example-App-SB-123';
    delete process.env.EBAY_SANDBOX_REDIRECT_URI;
    delete process.env.EBAY_REDIRECT_URI;

    const { createApp } = await import('@/server-http.js');

    const response = await request(createApp()).get('/sandbox/oauth/start');

    expect(response.status).toBe(302);
    const location = response.headers.location;
    expect(location).toContain('https://auth.sandbox.ebay.com/oauth2/authorize');
    const parsed = new URL(location);
    expect(parsed.searchParams.get('client_id')).toBe('test-sandbox-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('Example-App-SB-123');
  });

  it('accepts a direct cookie-array payload for admin Playwright session capture', async () => {
    const validateAndStoreMock = vi.fn().mockResolvedValue({
      backend: 'cloudflare_kv',
      stateKey: 'ebay_research_storage_state_json',
      metaKey: 'ebay_research_storage_state_meta',
      bytes: 256,
      cookieCount: 2,
      expiresAt: '2026-09-12T00:00:00.000Z',
      ttlSeconds: 123,
      storeTtlSeconds: 123,
      validation: {
        ok: true,
        responseStatus: 200,
        modulesSeen: ['SOLD'],
      },
    });

    vi.doMock('@/validation/providers/ebay-research.js', () => ({
      validateAndStoreEbayResearchSessionToKv: validateAndStoreMock,
    }));
    vi.doMock('@/validation/providers/ebay-research-session-store.js', () => ({
      createFreshEbayResearchSessionStoreResolution: vi.fn(() => ({
        selected: 'cloudflare_kv',
        stateKey: 'ebay_research_storage_state_json',
        metaKey: 'ebay_research_storage_state_meta',
        store: {},
      })),
    }));

    const { createApp } = await import('@/server-http.js');
    const cookies = [
      {
        name: 'full',
        value: 'test-cookie-full',
        domain: '.ebay.com',
        path: '/',
        expirationDate: 1790000000,
        httpOnly: true,
        secure: true,
        sameSite: 'no_restriction',
      },
      { name: 'minimal', value: 'test-cookie-minimal' },
    ];

    const response = await request(createApp())
      .post('/admin/playwright-session')
      .set('x-admin-api-key', 'test-admin-api-key')
      .send({ marketplace: 'EBAY-US', storageState: cookies });

    expect(response.status).toBe(200);
    expect(validateAndStoreMock).toHaveBeenCalledWith(
      'EBAY-US',
      { cookies, origins: [] },
      'storage_state'
    );
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        marketplace: 'EBAY-US',
        backend: 'cloudflare_kv',
        storageStateKey: 'ebay_research_storage_state_json',
        metadataKey: 'ebay_research_storage_state_meta',
        bytes: 256,
        cookieCount: 2,
      })
    );
  });
});
