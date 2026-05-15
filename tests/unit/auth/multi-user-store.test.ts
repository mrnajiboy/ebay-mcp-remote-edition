import { describe, expect, it } from 'vitest';
import { InMemoryKVStore } from '@/auth/kv-store.js';
import { MultiUserAuthStore } from '@/auth/multi-user-store.js';
import type { StoredTokenData } from '@/types/ebay.js';

function createStoredTokens(overrides: Partial<StoredTokenData> = {}): StoredTokenData {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://example.test/oauth/callback',
    ruName: 'Example-Example-PR-test',
    userAccessToken: 'test-access-token',
    userRefreshToken: 'test-refresh-token',
    tokenType: 'User Access Token',
    userAccessTokenExpiry: Date.now() + 7_200_000,
    userRefreshTokenExpiry: Date.now() + 86_400_000,
    scope: 'https://api.ebay.com/oauth/api_scope',
    ...overrides,
  };
}

describe('MultiUserAuthStore server request lookups', () => {
  it('resolves stored user tokens by client ID, user ID, and environment index', async () => {
    const store = new MultiUserAuthStore(new InMemoryKVStore());
    await store.saveUserTokens('user-1', 'production', createStoredTokens());

    const resolved = await store.getUserTokensByClientUser(
      'test-client-id',
      'user-1',
      'production'
    );

    expect(resolved?.userId).toBe('user-1');
    expect(resolved?.environment).toBe('production');
    expect(resolved?.tokenData.userRefreshToken).toBe('test-refresh-token');
  });

  it('does not resolve client-user indexes across environments', async () => {
    const store = new MultiUserAuthStore(new InMemoryKVStore());
    await store.saveUserTokens('user-1', 'production', createStoredTokens());

    const resolved = await store.getUserTokensByClientUser('test-client-id', 'user-1', 'sandbox');

    expect(resolved).toBeNull();
  });

  it('resolves stored user tokens by server bearer token', async () => {
    const store = new MultiUserAuthStore(new InMemoryKVStore());
    await store.saveUserTokens('user-1', 'production', createStoredTokens());

    const serverBearer = await store.createServerBearerToken('user-1', 'production');
    const resolved = await store.getUserTokensByServerBearerToken(serverBearer.token);

    expect(serverBearer.token).toMatch(/^ebay_mcp_/);
    expect(resolved?.userId).toBe('user-1');
    expect(resolved?.tokenData.clientSecret).toBe('test-client-secret');
  });
});
