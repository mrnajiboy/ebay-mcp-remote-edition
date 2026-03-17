import axios from 'axios';
import { getBaseUrl } from '@/config/environment.js';
import type {
  EbayAppAccessTokenResponse,
  EbayConfig,
  EbayUserToken,
  StoredTokenData,
} from '@/types/ebay.js';
import { MultiUserAuthStore } from '@/auth/multi-user-store.js';

export class EbayOAuthClient {
  private appAccessToken: string | null = null;
  private appAccessTokenExpiry = 0;
  private userTokens: StoredTokenData | null = null;
  private authStore = new MultiUserAuthStore();

  constructor(
    private config: EbayConfig,
    private context?: { userId?: string; environment?: 'production' | 'sandbox' }
  ) {}

  async initialize(): Promise<void> {
    if (this.context?.userId && this.context.environment) {
      const stored = await this.authStore.getUserTokens(
        this.context.userId,
        this.context.environment
      );
      if (stored?.tokenData) {
        this.userTokens = stored.tokenData;
        return;
      }
    }

    // Fallback: load from EBAY_USER_REFRESH_TOKEN environment variable
    const envRefreshToken = process.env.EBAY_USER_REFRESH_TOKEN;
    if (envRefreshToken) {
      try {
        const authUrl = `${getBaseUrl(this.config.environment)}/identity/v1/oauth2/token`;
        const credentials = Buffer.from(
          `${this.config.clientId}:${this.config.clientSecret}`
        ).toString('base64');

        const response = await axios.post<EbayUserToken>(
          authUrl,
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: envRefreshToken,
          }).toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${credentials}`,
            },
          }
        );

        const tokenData = response.data;
        const now = Date.now();
        this.userTokens = {
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          redirectUri: this.config.redirectUri,
          userAccessToken: tokenData.access_token,
          userRefreshToken: tokenData.refresh_token || envRefreshToken,
          tokenType: tokenData.token_type,
          userAccessTokenExpiry: now + tokenData.expires_in * 1000,
          userRefreshTokenExpiry: tokenData.refresh_token_expires_in
            ? now + tokenData.refresh_token_expires_in * 1000
            : now + 18 * 30 * 24 * 60 * 60 * 1000,
          scope: tokenData.scope,
        };
      } catch {
        // If refresh fails, leave userTokens as null
      }
    }
  }

  hasUserTokens(): boolean {
    return this.userTokens !== null;
  }

  private isUserAccessTokenExpired(tokens: StoredTokenData): boolean {
    return tokens.userAccessTokenExpiry ? Date.now() >= tokens.userAccessTokenExpiry : true;
  }

  private isUserRefreshTokenExpired(tokens: StoredTokenData): boolean {
    return tokens.userRefreshTokenExpiry ? Date.now() >= tokens.userRefreshTokenExpiry : true;
  }

  private async persistUserTokens(): Promise<void> {
    if (this.context?.userId && this.context.environment && this.userTokens) {
      await this.authStore.saveUserTokens(
        this.context.userId,
        this.context.environment,
        this.userTokens
      );
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.userTokens) {
      if (!this.isUserAccessTokenExpired(this.userTokens)) {
        return this.userTokens.userAccessToken;
      }
      if (!this.isUserRefreshTokenExpired(this.userTokens)) {
        await this.refreshUserToken();
        return this.userTokens.userAccessToken;
      }
      throw new Error(
        'User authorization expired. Re-authorize through browser OAuth and update your MCP connection token.'
      );
    }

    if (this.appAccessToken && Date.now() < this.appAccessTokenExpiry) {
      return this.appAccessToken;
    }

    await this.getOrRefreshAppAccessToken();
    return this.appAccessToken!;
  }

  async setUserTokens(
    accessToken: string,
    refreshToken: string,
    accessTokenExpiry?: number,
    refreshTokenExpiry?: number
  ): Promise<void> {
    const now = Date.now();
    this.userTokens = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      userAccessToken: accessToken,
      userRefreshToken: refreshToken,
      tokenType: 'Bearer',
      userAccessTokenExpiry: accessTokenExpiry ?? now + 7200 * 1000,
      userRefreshTokenExpiry: refreshTokenExpiry ?? now + 18 * 30 * 24 * 60 * 60 * 1000,
    };
    await this.persistUserTokens();
  }

  async getOrRefreshAppAccessToken(): Promise<string> {
    if (this.appAccessToken && Date.now() < this.appAccessTokenExpiry) {
      return this.appAccessToken;
    }

    const authUrl = `${getBaseUrl(this.config.environment)}/identity/v1/oauth2/token`;
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64'
    );

    const response = await axios.post<EbayAppAccessTokenResponse>(
      authUrl,
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
      }
    );

    this.appAccessToken = response.data.access_token;
    this.appAccessTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    return this.appAccessToken;
  }

  async exchangeCodeForToken(code: string): Promise<EbayUserToken> {
    if (!this.config.redirectUri) {
      throw new Error('Redirect URI is required for authorization code exchange');
    }

    const tokenUrl = `${getBaseUrl(this.config.environment)}/identity/v1/oauth2/token`;
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64'
    );

    try {
      const response = await axios.post<EbayUserToken>(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.redirectUri,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`,
          },
        }
      );

      const tokenData = response.data;
      const now = Date.now();
      this.userTokens = {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        redirectUri: this.config.redirectUri,
        userAccessToken: tokenData.access_token,
        userRefreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
        userAccessTokenExpiry: now + tokenData.expires_in * 1000,
        userRefreshTokenExpiry: now + tokenData.refresh_token_expires_in * 1000,
        scope: tokenData.scope,
      };
      await this.persistUserTokens();
      return tokenData;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const data = error.response.data as { error?: string; error_description?: string };
        if (data.error_description) {
          throw new Error(data.error_description);
        }
        if (data.error) {
          throw new Error(data.error);
        }
      }
      throw error;
    }
  }

  async refreshUserToken(): Promise<void> {
    if (!this.userTokens) {
      throw new Error('No user tokens available to refresh');
    }

    const authUrl = `${getBaseUrl(this.config.environment)}/identity/v1/oauth2/token`;
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64'
    );

    const response = await axios.post<EbayUserToken>(
      authUrl,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.userTokens.userRefreshToken,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
      }
    );

    const tokenData = response.data;
    const now = Date.now();
    this.userTokens = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      userAccessToken: tokenData.access_token,
      userRefreshToken: tokenData.refresh_token || this.userTokens.userRefreshToken,
      tokenType: tokenData.token_type,
      userAccessTokenExpiry: now + tokenData.expires_in * 1000,
      userRefreshTokenExpiry: tokenData.refresh_token_expires_in
        ? now + tokenData.refresh_token_expires_in * 1000
        : this.userTokens.userRefreshTokenExpiry,
      scope: tokenData.scope || this.userTokens.scope,
    };
    await this.persistUserTokens();
  }

  isAuthenticated(): boolean {
    if (this.userTokens && !this.isUserAccessTokenExpired(this.userTokens)) {
      return true;
    }
    return this.appAccessToken !== null && Date.now() < this.appAccessTokenExpiry;
  }

  clearAllTokens(): void {
    this.appAccessToken = null;
    this.appAccessTokenExpiry = 0;
    this.userTokens = null;
  }

  getTokenInfo(): {
    hasUserToken: boolean;
    hasAppAccessToken: boolean;
    scopeInfo?: { tokenScopes: string[]; environmentScopes: string[]; missingScopes: string[] };
  } {
    const info: {
      hasUserToken: boolean;
      hasAppAccessToken: boolean;
      scopeInfo?: { tokenScopes: string[]; environmentScopes: string[]; missingScopes: string[] };
    } = {
      hasUserToken: this.userTokens !== null && !this.isUserAccessTokenExpired(this.userTokens),
      hasAppAccessToken: this.appAccessToken !== null && Date.now() < this.appAccessTokenExpiry,
    };

    if (this.userTokens?.scope) {
      const tokenScopes = this.userTokens.scope.split(' ');
      const environmentScopes = ['https://api.ebay.com/oauth/api_scope'];
      const tokenScopeSet = new Set(tokenScopes);
      const missingScopes = environmentScopes.filter((scope) => !tokenScopeSet.has(scope));
      info.scopeInfo = { tokenScopes, environmentScopes, missingScopes };
    }

    return info;
  }

  getUserTokens(): StoredTokenData | null {
    return this.userTokens;
  }

  getCachedAppAccessToken(): string | null {
    return this.appAccessToken;
  }

  getCachedAppAccessTokenExpiry(): number {
    return this.appAccessTokenExpiry;
  }
}
