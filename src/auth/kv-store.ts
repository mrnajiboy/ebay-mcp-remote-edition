import axios, { type AxiosInstance } from 'axios';

export class CloudflareKVStore {
  private client: AxiosInstance;
  private accountId: string;
  private namespaceId: string;

  constructor() {
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

  async get<T>(key: string): Promise<T | null> {
    try {
      const response = await this.client.get(`/values/${encodeURIComponent(key)}`, {
        responseType: 'text',
      });
      return JSON.parse(response.data as string) as T;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async put(key: string, value: unknown, expirationTtl?: number): Promise<void> {
    const params = expirationTtl ? { expiration_ttl: expirationTtl } : undefined;
    await this.client.put(`/values/${encodeURIComponent(key)}`, JSON.stringify(value), { params });
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(`/values/${encodeURIComponent(key)}`);
  }
}
