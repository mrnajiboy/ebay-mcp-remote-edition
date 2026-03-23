/**
 * Unit tests for kv-store.ts
 *
 * Core regression: verify that when EBAY_TOKEN_STORE_BACKEND=memory the factory
 * returns an InMemoryKVStore and that store NEVER makes external HTTP calls.
 * This is the test that catches the "logs say memory but CloudflareKVStore.put
 * is in the stack trace" bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createKVStore,
  resetKVStoreSingleton,
  InMemoryKVStore,
  CloudflareKVStore,
  UpstashRedisKVStore,
} from '@/auth/kv-store.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function withBackendEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.EBAY_TOKEN_STORE_BACKEND;
  if (value === undefined) {
    delete process.env.EBAY_TOKEN_STORE_BACKEND;
  } else {
    process.env.EBAY_TOKEN_STORE_BACKEND = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.EBAY_TOKEN_STORE_BACKEND;
    } else {
      process.env.EBAY_TOKEN_STORE_BACKEND = prev;
    }
  }
}

/**
 * Set stub credentials for Cloudflare KV so the constructor doesn't throw.
 * Returns a cleanup function.
 */
function withCloudflareStubCreds(): () => void {
  const prev = {
    id: process.env.CLOUDFLARE_ACCOUNT_ID,
    ns: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  };
  process.env.CLOUDFLARE_ACCOUNT_ID = '__test__';
  process.env.CLOUDFLARE_KV_NAMESPACE_ID = '__test__';
  process.env.CLOUDFLARE_API_TOKEN = '__test__';
  return () => {
    if (prev.id === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = prev.id;
    if (prev.ns === undefined) delete process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    else process.env.CLOUDFLARE_KV_NAMESPACE_ID = prev.ns;
    if (prev.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = prev.token;
  };
}

/**
 * Set stub credentials for Upstash Redis so the constructor doesn't throw.
 * Returns a cleanup function.
 */
function withUpstashStubCreds(): () => void {
  const prev = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = '__test__';
  return () => {
    if (prev.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prev.url;
    if (prev.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prev.token;
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Always start each test with a clean singleton so env-var changes take effect.
  resetKVStoreSingleton(null);
  // Suppress the startup console.log from createKVStore() during tests.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  resetKVStoreSingleton(null);
  vi.restoreAllMocks();
});

// ── Factory backend selection ─────────────────────────────────────────────────

describe('createKVStore() – backend selection', () => {
  it('returns InMemoryKVStore when EBAY_TOKEN_STORE_BACKEND=memory', () => {
    withBackendEnv('memory', () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(InMemoryKVStore);
      expect(store.backendName).toBe('InMemoryKVStore');
    });
  });

  it('returns InMemoryKVStore when EBAY_TOKEN_STORE_BACKEND=in-memory', () => {
    withBackendEnv('in-memory', () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(InMemoryKVStore);
    });
  });

  it('returns InMemoryKVStore for mixed-case EBAY_TOKEN_STORE_BACKEND=MEMORY', () => {
    withBackendEnv('MEMORY', () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(InMemoryKVStore);
    });
  });

  it('returns CloudflareKVStore when EBAY_TOKEN_STORE_BACKEND=cloudflare-kv', () => {
    const cleanup = withCloudflareStubCreds();
    try {
      withBackendEnv('cloudflare-kv', () => {
        const store = createKVStore();
        expect(store).toBeInstanceOf(CloudflareKVStore);
        expect(store.backendName).toBe('CloudflareKVStore');
      });
    } finally {
      cleanup();
    }
  });

  it('returns CloudflareKVStore when EBAY_TOKEN_STORE_BACKEND=cloudflare', () => {
    const cleanup = withCloudflareStubCreds();
    try {
      withBackendEnv('cloudflare', () => {
        const store = createKVStore();
        expect(store).toBeInstanceOf(CloudflareKVStore);
      });
    } finally {
      cleanup();
    }
  });

  it('returns UpstashRedisKVStore when EBAY_TOKEN_STORE_BACKEND=upstash-redis', () => {
    const cleanup = withUpstashStubCreds();
    try {
      withBackendEnv('upstash-redis', () => {
        const store = createKVStore();
        expect(store).toBeInstanceOf(UpstashRedisKVStore);
        expect(store.backendName).toBe('UpstashRedisKVStore');
      });
    } finally {
      cleanup();
    }
  });

  it('returns UpstashRedisKVStore when EBAY_TOKEN_STORE_BACKEND=redis', () => {
    const cleanup = withUpstashStubCreds();
    try {
      withBackendEnv('redis', () => {
        const store = createKVStore();
        expect(store).toBeInstanceOf(UpstashRedisKVStore);
      });
    } finally {
      cleanup();
    }
  });

  it('defaults to CloudflareKVStore when EBAY_TOKEN_STORE_BACKEND is unset', () => {
    const cleanup = withCloudflareStubCreds();
    try {
      withBackendEnv(undefined, () => {
        const store = createKVStore();
        expect(store).toBeInstanceOf(CloudflareKVStore);
      });
    } finally {
      cleanup();
    }
  });

  it('defaults to CloudflareKVStore for an unrecognised value', () => {
    const cleanup = withCloudflareStubCreds();
    try {
      withBackendEnv('something-unknown', () => {
        const store = createKVStore();
        expect(store).toBeInstanceOf(CloudflareKVStore);
      });
    } finally {
      cleanup();
    }
  });
});

// ── Singleton guarantee ───────────────────────────────────────────────────────

describe('createKVStore() – singleton', () => {
  it('returns the exact same instance on every call within a process', () => {
    withBackendEnv('memory', () => {
      const a = createKVStore();
      const b = createKVStore();
      const c = createKVStore();
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });

  it('does NOT re-read the env var after the singleton is built', () => {
    // Build with memory backend first.
    withBackendEnv('memory', () => {
      const first = createKVStore();
      expect(first).toBeInstanceOf(InMemoryKVStore);
    });

    // Changing the env var now should have no effect — singleton is already set.
    // Add stub Cloudflare creds so if it DID reconstruct, it wouldn't throw.
    const cleanup = withCloudflareStubCreds();
    process.env.EBAY_TOKEN_STORE_BACKEND = 'cloudflare-kv';
    try {
      const second = createKVStore();
      // Still the same InMemoryKVStore from the first call.
      expect(second).toBeInstanceOf(InMemoryKVStore);
    } finally {
      delete process.env.EBAY_TOKEN_STORE_BACKEND;
      cleanup();
    }
  });

  it('resetKVStoreSingleton(null) forces fresh construction on next call', () => {
    withBackendEnv('memory', () => {
      const before = createKVStore();
      resetKVStoreSingleton(null);
      const after = createKVStore();
      // Different instances — reset worked.
      expect(after).not.toBe(before);
      expect(after).toBeInstanceOf(InMemoryKVStore);
    });
  });

  it('resetKVStoreSingleton(replacement) installs a pre-built store', () => {
    const custom = new InMemoryKVStore();
    resetKVStoreSingleton(custom);
    expect(createKVStore()).toBe(custom);
    expect(createKVStore()).toBe(custom); // still singleton
  });
});

// ── Memory backend never makes HTTP calls ─────────────────────────────────────

describe('InMemoryKVStore – no external HTTP calls', () => {
  /**
   * This is THE regression test.
   *
   * If createKVStore() ever returns a CloudflareKVStore when EBAY_TOKEN_STORE_BACKEND=memory,
   * the axios.create() call inside CloudflareKVStore constructor would run, and any
   * subsequent .put() / .get() call would hit Cloudflare's API (producing the 429 the user saw).
   *
   * We verify this by asserting that neither get() nor put() nor delete() throw an
   * AxiosError (i.e. never touch the network) when the memory backend is in use.
   */

  it('put, get, and delete complete without any network calls', async () => {
    withBackendEnv('memory', () => {
      // The singleton was reset in beforeEach, so this builds a fresh InMemoryKVStore.
    });

    const store = (() => {
      process.env.EBAY_TOKEN_STORE_BACKEND = 'memory';
      resetKVStoreSingleton(null);
      const s = createKVStore();
      delete process.env.EBAY_TOKEN_STORE_BACKEND;
      return s;
    })();

    expect(store.backendName).toBe('InMemoryKVStore');

    // These must not throw (no HTTP client involved).
    await store.put('key1', { hello: 'world' });
    const val = await store.get<{ hello: string }>('key1');
    expect(val).toEqual({ hello: 'world' });
    await store.delete('key1');
    expect(await store.get('key1')).toBeNull();
  });

  it('get returns null for missing keys without throwing', async () => {
    const store = new InMemoryKVStore();
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('respects TTL – expired entries are treated as missing', async () => {
    const store = new InMemoryKVStore();
    // Write with a 1-second TTL then fake-advance time.
    await store.put('ephemeral', { data: 'x' }, 1);

    // Immediately readable.
    expect(await store.get('ephemeral')).toEqual({ data: 'x' });

    // Advance time by 2 seconds using fake timers.
    vi.useFakeTimers();
    vi.advanceTimersByTime(2_000);

    expect(await store.get('ephemeral')).toBeNull();

    vi.useRealTimers();
  });
});

// ── Multi-instance test: two MultiUserAuthStore instances share one backend ───

describe('singleton – two MultiUserAuthStore instances share one KV backend', () => {
  it('both stores read from and write to the same underlying KV', async () => {
    // Use injected stores both pointing at the same InMemoryKVStore instance.
    const { MultiUserAuthStore } = await import('@/auth/multi-user-store.js');

    const sharedKv = new InMemoryKVStore();
    const storeA = new MultiUserAuthStore(sharedKv);
    const storeB = new MultiUserAuthStore(sharedKv);

    expect(storeA.backendName).toBe('InMemoryKVStore');
    expect(storeB.backendName).toBe('InMemoryKVStore');

    // Create a session via storeA, then look it up via storeB.
    const session = await storeA.createSession('user-1', 'production');
    const found = await storeB.getSession(session.sessionToken);

    expect(found).not.toBeNull();
    expect(found?.userId).toBe('user-1');
  });
});
