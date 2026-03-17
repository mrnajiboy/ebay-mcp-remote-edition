import { randomUUID } from 'crypto';
import type { EbayEnvironment } from '@/config/environment.js';
import type { StoredTokenData } from '@/types/ebay.js';
import { CloudflareKVStore } from '@/auth/kv-store.js';

export interface OAuthStateRecord {
  state: string;
  environment: EbayEnvironment;
  createdAt: string;
  returnTo?: string;
  /** Set when this state was initiated by an MCP OAuth 2.1 authorization request */
  mcpClientId?: string;
  mcpRedirectUri?: string;
  mcpState?: string;
  mcpCodeChallenge?: string;
  mcpCodeChallengeMethod?: string;
}

/** RFC 7591 dynamically-registered client */
export interface ClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: string;
}

/** Short-lived authorization code issued after eBay OAuth completes in MCP flow */
export interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  userId: string;
  environment: EbayEnvironment;
  createdAt: string;
}

export interface UserTokenRecord {
  userId: string;
  environment: EbayEnvironment;
  tokenData: StoredTokenData;
  updatedAt: string;
}

export interface SessionRecord {
  sessionToken: string;
  userId: string;
  environment: EbayEnvironment;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export class MultiUserAuthStore {
  private kv = new CloudflareKVStore();

  private stateKey(state: string): string {
    return `oauth_state:${state}`;
  }

  private userTokenKey(userId: string, environment: EbayEnvironment): string {
    return `user:${userId}:env:${environment}:tokens`;
  }

  private sessionKey(sessionToken: string): string {
    return `session:${sessionToken}`;
  }

  async createOAuthState(
    environment: EbayEnvironment,
    returnTo?: string,
    mcpContext?: {
      mcpClientId: string;
      mcpRedirectUri: string;
      mcpState?: string;
      mcpCodeChallenge: string;
      mcpCodeChallengeMethod: string;
    }
  ): Promise<OAuthStateRecord> {
    const state = randomUUID();
    const record: OAuthStateRecord = {
      state,
      environment,
      createdAt: new Date().toISOString(),
      returnTo,
      ...mcpContext,
    };
    await this.kv.put(this.stateKey(state), record, 15 * 60);
    return record;
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const key = this.stateKey(state);
    const record = await this.kv.get<OAuthStateRecord>(key);
    if (record) {
      await this.kv.delete(key);
    }
    return record;
  }

  async saveUserTokens(
    userId: string,
    environment: EbayEnvironment,
    tokenData: StoredTokenData
  ): Promise<void> {
    const record: UserTokenRecord = {
      userId,
      environment,
      tokenData,
      updatedAt: new Date().toISOString(),
    };
    await this.kv.put(this.userTokenKey(userId, environment), record);
  }

  async getUserTokens(
    userId: string,
    environment: EbayEnvironment
  ): Promise<UserTokenRecord | null> {
    return await this.kv.get<UserTokenRecord>(this.userTokenKey(userId, environment));
  }

  async createSession(userId: string, environment: EbayEnvironment): Promise<SessionRecord> {
    const sessionToken = randomUUID() + randomUUID();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionToken,
      userId,
      environment,
      createdAt: now,
      lastUsedAt: now,
    };
    await this.kv.put(this.sessionKey(sessionToken), record);
    return record;
  }

  async getSession(sessionToken: string): Promise<SessionRecord | null> {
    return await this.kv.get<SessionRecord>(this.sessionKey(sessionToken));
  }

  async touchSession(sessionToken: string): Promise<void> {
    const record = await this.getSession(sessionToken);
    if (!record || record.revokedAt) {
      return;
    }
    record.lastUsedAt = new Date().toISOString();
    await this.kv.put(this.sessionKey(sessionToken), record);
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const record = await this.getSession(sessionToken);
    if (!record) {
      return;
    }
    record.revokedAt = new Date().toISOString();
    await this.kv.put(this.sessionKey(sessionToken), record);
  }

  async deleteSession(sessionToken: string): Promise<void> {
    await this.kv.delete(this.sessionKey(sessionToken));
  }

  // ── RFC 7591 Dynamic Client Registration ──────────────────────────────────

  async registerClient(redirectUris: string[], clientName?: string): Promise<ClientRecord> {
    const clientId = randomUUID();
    const record: ClientRecord = {
      clientId,
      redirectUris,
      clientName,
      createdAt: new Date().toISOString(),
    };
    await this.kv.put(`client:${clientId}`, record);
    return record;
  }

  async getClient(clientId: string): Promise<ClientRecord | null> {
    return await this.kv.get<ClientRecord>(`client:${clientId}`);
  }

  // ── MCP Authorization Code (short-lived, PKCE-protected) ─────────────────

  async createAuthCode(
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    codeChallengeMethod: string,
    userId: string,
    environment: EbayEnvironment
  ): Promise<AuthCodeRecord> {
    const code = randomUUID() + randomUUID();
    const record: AuthCodeRecord = {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      userId,
      environment,
      createdAt: new Date().toISOString(),
    };
    await this.kv.put(`auth_code:${code}`, record, 10 * 60); // 10 min TTL
    return record;
  }

  async consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const key = `auth_code:${code}`;
    const record = await this.kv.get<AuthCodeRecord>(key);
    if (record) {
      await this.kv.delete(key);
    }
    return record;
  }
}
