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
});
