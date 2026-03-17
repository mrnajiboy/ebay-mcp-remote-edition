import axios, { type AxiosInstance } from 'axios';

// ── Shared interface ──────────────────────────────────────────────────────────

/** Common contract for all KV store backends. */
export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, expirationTtl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// ── In-memory backend ─────────────────────────────────────────────────────────

interface MemEntry {
  value: unknown;
  /** Unix ms timestamp after which the entry is expired. Undefined = never expires. */
  expiresAt?: number;
}

/**
 * Purely in-memory KV store with optional per-entry TTL.
 * Useful for local development, single-user setups, or when
 * EBAY_TOKEN_STORE_BACKEND=memory.
 * All data is lost on process restart.
 */
export class InMemoryKVStore implements KVStore {
  private store = new Map<string, MemEntry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async put(key: string, value: unknown, expirationTtl?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: expirationTtl !== undefined ? Date.now() + expirationTtl * 1_000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ── Cloudflare KV backend ─────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Cloudflare KV REST API backend with an in-memory read-through cache.
 * Used when EBAY_TOKEN_STORE_BACKEND=cloudflare-kv (the default for hosted deployments).
 */
export class CloudflareKVStore implements KVStore {
  private client: AxiosInstance;
  private accountId: string;
  private namespaceId: string;
  /** In-memory read-through cache to avoid redundant Cloudflare KV API calls */
  private cache = new Map<string, CacheEntry<unknown>>();
  /** How long (ms) to hold a cached value before re-fetching from KV. Default: 5 minutes. */
  private cacheTtlMs: number;

  constructor(cacheTtlMs = 5 * 60 * 1_000) {
    this.cacheTtlMs = cacheTtlMs;
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
    this.namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID || '';
    const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';

    this.client = axios.create({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  private isCacheValid(entry: CacheEntry<unknown>): boolean {
    return Date.now() < entry.expiresAt;
  }

  async get<T>(key: string): Promise<T | null> {
    // Serve from in-memory cache when still fresh
    const cached = this.cache.get(key);
    if (cached && this.isCacheValid(cached)) {
      return cached.value as T | null;
    }

    try {
      const response = await this.client.get(`/values/${encodeURIComponent(key)}`, {
        responseType: 'text',
      });
      const value = JSON.parse(response.data as string) as T;
      this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
      return value;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // Cache the miss so we don't hammer KV for non-existent keys either
        this.cache.set(key, { value: null, expiresAt: Date.now() + this.cacheTtlMs });
        return null;
      }
      throw error;
    }
  }

  async put(key: string, value: unknown, expirationTtl?: number): Promise<void> {
    const params = expirationTtl ? { expiration_ttl: expirationTtl } : undefined;
    await this.client.put(`/values/${encodeURIComponent(key)}`, JSON.stringify(value), { params });

    // Keep the in-memory cache consistent with what we wrote.
    // If the KV entry has its own TTL, honour it for the cache as well.
    const cacheTtl =
      expirationTtl ? Math.min(expirationTtl * 1_000, this.cacheTtlMs) : this.cacheTtlMs;
    this.cache.set(key, { value, expiresAt: Date.now() + cacheTtl });
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(`/values/${encodeURIComponent(key)}`);
    this.cache.delete(key);
  }

  /** Manually evict a single key from the local cache (e.g. after an external update). */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Flush the entire in-memory cache. */
  flushCache(): void {
    this.cache.clear();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the appropriate KV store backend based on the EBAY_TOKEN_STORE_BACKEND
 * environment variable:
 *
 *   memory        → InMemoryKVStore  (no external dependencies, data lost on restart)
 *   cloudflare-kv → CloudflareKVStore (default; requires CLOUDFLARE_* env vars)
 *
 * If the variable is unset or unrecognised, defaults to cloudflare-kv so that
 * existing hosted deployments continue to work without any config change.
 */
export function createKVStore(): KVStore {
  const backend = (process.env.EBAY_TOKEN_STORE_BACKEND ?? 'cloudflare-kv').toLowerCase().trim();

  switch (backend) {
    case 'memory':
    case 'in-memory':
      return new InMemoryKVStore();
    case 'cloudflare-kv':
    case 'cloudflare':
    default:
      return new CloudflareKVStore();
  }
}
