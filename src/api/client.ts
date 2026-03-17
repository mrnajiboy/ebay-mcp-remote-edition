import { EbayOAuthClient } from '@/auth/oauth.js';
import { getBaseUrl } from '@/config/environment.js';
import type { EbayApiError, EbayConfig } from '@/types/ebay.js';
import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { apiLogger, logRequest, logResponse, logErrorResponse } from '@/utils/logger.js';

interface AxiosConfigWithRetry extends AxiosRequestConfig {
  __authRetryCount?: number;
  __retryCount?: number;
}

class RateLimitTracker {
  private requestTimestamps: number[] = [];
  private readonly windowMs = 60000;
  private readonly maxRequests = 5000;

  canMakeRequest(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((timestamp) => now - timestamp < this.windowMs);
    return this.requestTimestamps.length < this.maxRequests;
  }

  recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  getStats(): { current: number; max: number; windowMs: number } {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((timestamp) => now - timestamp < this.windowMs);
    return { current: this.requestTimestamps.length, max: this.maxRequests, windowMs: this.windowMs };
  }
}

export class EbayApiClient {
  private httpClient: AxiosInstance;
  private authClient: EbayOAuthClient;
  private baseUrl: string;
  private rateLimitTracker: RateLimitTracker;
  private config: EbayConfig;

  private getDefaultHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.config.contentLanguage) {
      headers['Content-Language'] = this.config.contentLanguage;
    }
    if (this.config.marketplaceId) {
      headers['X-EBAY-C-MARKETPLACE-ID'] = this.config.marketplaceId;
    }
    return headers;
  }

  constructor(
    config: EbayConfig,
    context?: {
      userId?: string;
      environment?: 'production' | 'sandbox';
    }
  ) {
    this.config = config;
    this.authClient = new EbayOAuthClient(config, context);
    this.baseUrl = getBaseUrl(config.environment);
    this.rateLimitTracker = new RateLimitTracker();

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: this.getDefaultHeaders(),
    });

    this.httpClient.interceptors.request.use(async (config) => {
      if (!this.rateLimitTracker.canMakeRequest()) {
        const stats = this.rateLimitTracker.getStats();
        throw new Error(`Rate limit exceeded: ${stats.current}/${stats.max} requests in ${stats.windowMs}ms window.`);
      }
      const token = await this.authClient.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      this.rateLimitTracker.recordRequest();
      logRequest(config.method || 'GET', `${config.baseURL}${config.url}`, config.params as Record<string, unknown>, config.data);
      return config;
    });

    this.httpClient.interceptors.response.use(
      (response) => {
        const remaining = response.headers['x-ebay-c-ratelimit-remaining'];
        const limit = response.headers['x-ebay-c-ratelimit-limit'];
        logResponse(response.status, response.statusText, response.data, remaining, limit);
        return response;
      },
      async (error: AxiosError) => {
        const config = error.config as AxiosConfigWithRetry | undefined;
        if (error.response) {
          logErrorResponse(error.response.status, error.response.statusText, `${config?.baseURL}${config?.url}`, error.response.data);
        }

        if (error.response?.status === 401 && config) {
          const retryCount = config.__authRetryCount || 0;
          if (retryCount === 0) {
            config.__authRetryCount = 1;
            await this.authClient.refreshUserToken();
            const newToken = await this.authClient.getAccessToken();
            if (config.headers) {
              config.headers.Authorization = `Bearer ${newToken}`;
            }
            return await this.httpClient.request(config);
          }
          const ebayError = error.response?.data as EbayApiError;
          const errorMessage = ebayError.errors?.[0]?.longMessage || ebayError.errors?.[0]?.message || 'Invalid access token';
          throw new Error(`${errorMessage}. Automatic token refresh failed.`);
        }

        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'];
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
          throw new Error(`eBay API rate limit exceeded. Retry after ${waitTime / 1000} seconds.`);
        }

        if (error.response?.status && error.response.status >= 500 && config) {
          const retryCount = config.__retryCount || 0;
          if (retryCount < 3) {
            config.__retryCount = retryCount + 1;
            const delay = Math.pow(2, retryCount) * 1000;
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 5000)));
            return await this.httpClient.request(config);
          }
        }

        if (axios.isAxiosError(error) && error.response?.data) {
          const ebayError = error.response.data as EbayApiError;
          const errorMessage = ebayError.errors?.[0]?.longMessage || ebayError.errors?.[0]?.message || error.message;
          throw new Error(`eBay API Error: ${errorMessage}`);
        }

        throw error;
      }
    );
  }

  async initialize(): Promise<void> {
    await this.authClient.initialize();
  }

  isAuthenticated(): boolean {
    return this.authClient.isAuthenticated();
  }

  hasUserTokens(): boolean {
    return this.authClient.hasUserTokens();
  }

  async setUserTokens(
    accessToken: string,
    refreshToken: string,
    accessTokenExpiry?: number,
    refreshTokenExpiry?: number
  ): Promise<void> {
    await this.authClient.setUserTokens(accessToken, refreshToken, accessTokenExpiry, refreshTokenExpiry);
  }

  getTokenInfo() {
    return this.authClient.getTokenInfo();
  }

  getOAuthClient(): EbayOAuthClient {
    return this.authClient;
  }

  getRateLimitStats() {
    return this.rateLimitTracker.getStats();
  }

  getConfig(): EbayConfig {
    return this.config;
  }

  async refreshUserToken(): Promise<void> {
    await this.authClient.refreshUserToken();
  }

  async get<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.httpClient.get<T>(url, { params });
    return response.data;
  }

  async post<T = unknown>(url: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const response = await this.httpClient.post<T>(url, data, { params });
    return response.data;
  }

  async put<T = unknown>(url: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const response = await this.httpClient.put<T>(url, data, { params });
    return response.data;
  }

  async delete<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.httpClient.delete<T>(url, { params });
    return response.data;
  }

  async getWithFullUrl<T = unknown>(fullUrl: string, params?: Record<string, unknown>): Promise<T> {
    const token = await this.authClient.getAccessToken();
    const response = await axios.get<T>(fullUrl, {
      params,
      headers: {
        Authorization: `Bearer ${token}`,
        ...this.getDefaultHeaders(),
      },
      timeout: 30000,
    });
    return response.data;
  }
}
