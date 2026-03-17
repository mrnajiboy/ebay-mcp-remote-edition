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
    withBackendEnv('cloudflare-kv', () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(CloudflareKVStore);
      expect(store.backendName).toBe('CloudflareKVStore');
    });
  });

  it('returns CloudflareKVStore when EBAY_TOKEN_STORE_BACKEND=cloudflare', () => {
    withBackendEnv('cloudflare', () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(CloudflareKVStore);
    });
  });

  it('defaults to CloudflareKVStore when EBAY_TOKEN_STORE_BACKEND is unset', () => {
    withBackendEnv(undefined, () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(CloudflareKVStore);
    });
  });

  it('defaults to CloudflareKVStore for an unrecognised value', () => {
    withBackendEnv('redis', () => {
      const store = createKVStore();
      expect(store).toBeInstanceOf(CloudflareKVStore);
    });
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
    process.env.EBAY_TOKEN_STORE_BACKEND = 'cloudflare-kv';
    try {
      const second = createKVStore();
      // Still the same InMemoryKVStore from the first call.
      expect(second).toBeInstanceOf(InMemoryKVStore);
    } finally {
      delete process.env.EBAY_TOKEN_STORE_BACKEND;
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
