import axios, { type AxiosInstance } from 'axios';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class CloudflareKVStore {
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
    const cacheTtl = expirationTtl ? Math.min(expirationTtl * 1_000, this.cacheTtlMs) : this.cacheTtlMs;
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
