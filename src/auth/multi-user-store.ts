import { randomUUID } from 'crypto';
import type { EbayEnvironment } from '@/config/environment.js';
import type { StoredTokenData } from '@/types/ebay.js';
import { createKVStore, type KVStore } from '@/auth/kv-store.js';

// ── TTL constants (seconds) ────────────────────────────────────────────────
/** 15 minutes — matches the eBay OAuth state parameter lifetime. */
const OAUTH_STATE_TTL_S = 15 * 60;
/** 10 minutes — short-lived MCP authorization code. */
const AUTH_CODE_TTL_S = 10 * 60;
/** 30 days — default; configurable via SESSION_TTL_SECONDS env var. */
const SESSION_TTL_FALLBACK_S = 30 * 24 * 60 * 60;
const _rawSessionTtl = process.env.SESSION_TTL_SECONDS;
const SESSION_TTL_S: number = (() => {
  if (_rawSessionTtl === undefined || _rawSessionTtl.trim() === '') {
    return SESSION_TTL_FALLBACK_S;
  }
  const parsed = Number(_rawSessionTtl);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[multi-user-store] SESSION_TTL_SECONDS="${_rawSessionTtl}" is invalid; falling back to ${SESSION_TTL_FALLBACK_S}s (30 days)`
    );
    return SESSION_TTL_FALLBACK_S;
  }
  return Math.floor(parsed);
})();
/** 18 months — default fallback when no refresh token expiry is available. */
const DEFAULT_REFRESH_TOKEN_TTL_S = 18 * 30 * 24 * 60 * 60;

function secondsFromNow(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1_000).toISOString();
}

export interface OAuthStateRecord {
  state: string;
  environment: EbayEnvironment;
  createdAt: string;
  expiresAt: string;
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
  /**
   * The eBay environment this client was registered for (sandbox | production).
   * Set when registration goes through an env-scoped path (e.g. /sandbox/register).
   * Used by the root authorize endpoint as a fallback when no ?env= query param
   * is present and the client's cached auth-server URL points to root /authorize.
   */
  environment?: EbayEnvironment;
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
  expiresAt: string;
}

export interface UserTokenRecord {
  userId: string;
  environment: EbayEnvironment;
  tokenData: StoredTokenData;
  updatedAt: string;
  expiresAt: string;
}

export interface SessionRecord {
  sessionToken: string;
  userId: string;
  environment: EbayEnvironment;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export class MultiUserAuthStore {
  private kv: KVStore;

  /**
   * @param kv  Optional KV store override. If omitted the process-wide singleton
   *            returned by `createKVStore()` is used (the normal production path).
   *            Pass an explicit store in unit tests to avoid touching env vars.
   */
  constructor(kv?: KVStore) {
    this.kv = kv ?? createKVStore();
  }

  /** Returns the backend name of the underlying KV store (e.g. "InMemoryKVStore"). */
  get backendName(): string {
    return this.kv.backendName;
  }

  /**
   * In-memory map of sessionToken → timestamp of last KV write for touchSession.
   * Prevents a KV PUT on every single authenticated request — we only persist
   * `lastUsedAt` once per TOUCH_THROTTLE_MS (default: 1 hour).
   */
  private sessionTouchCache = new Map<string, number>();
  private static readonly TOUCH_THROTTLE_MS = 60 * 60 * 1_000; // 1 hour

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
      expiresAt: secondsFromNow(OAUTH_STATE_TTL_S),
      returnTo,
      ...mcpContext,
    };
    await this.kv.put(this.stateKey(state), record, OAUTH_STATE_TTL_S);
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
    // Derive TTL from refresh token expiry when available; fall back to 18 months.
    let ttlSeconds = DEFAULT_REFRESH_TOKEN_TTL_S;
    if (tokenData.userRefreshTokenExpiry) {
      const expiryMs =
        typeof tokenData.userRefreshTokenExpiry === 'number'
          ? tokenData.userRefreshTokenExpiry
          : new Date(tokenData.userRefreshTokenExpiry).getTime();
      const remaining = Math.floor((expiryMs - Date.now()) / 1_000);
      if (remaining > 0) {
        ttlSeconds = remaining;
      }
    }

    const record: UserTokenRecord = {
      userId,
      environment,
      tokenData,
      updatedAt: new Date().toISOString(),
      expiresAt: secondsFromNow(ttlSeconds),
    };
    await this.kv.put(this.userTokenKey(userId, environment), record, ttlSeconds);
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
      expiresAt: secondsFromNow(SESSION_TTL_S),
      lastUsedAt: now,
    };
    await this.kv.put(this.sessionKey(sessionToken), record, SESSION_TTL_S);
    return record;
  }

  async getSession(sessionToken: string): Promise<SessionRecord | null> {
    return await this.kv.get<SessionRecord>(this.sessionKey(sessionToken));
  }

  async touchSession(sessionToken: string): Promise<void> {
    const now = Date.now();
    const lastTouched = this.sessionTouchCache.get(sessionToken);

    // Skip the KV write entirely if we touched this session recently.
    // The in-memory cache in CloudflareKVStore already keeps reads free,
    // so the only cost we're avoiding here is the unnecessary KV PUT.
    if (lastTouched !== undefined && now - lastTouched < MultiUserAuthStore.TOUCH_THROTTLE_MS) {
      return;
    }

    const record = await this.getSession(sessionToken);
    if (!record || record.revokedAt) {
      return;
    }

    // Recalculate remaining TTL so Redis/KV doesn't expire an active session.
    const expiresAt = new Date(record.expiresAt).getTime();
    const remainingTtl = Math.max(Math.floor((expiresAt - now) / 1_000), SESSION_TTL_S);

    record.lastUsedAt = new Date(now).toISOString();
    await this.kv.put(this.sessionKey(sessionToken), record, remainingTtl);
    this.sessionTouchCache.set(sessionToken, now);
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const record = await this.getSession(sessionToken);
    if (!record) {
      return;
    }
    // Keep whatever TTL remains — just mark as revoked.
    const expiresAt = new Date(record.expiresAt).getTime();
    const remainingTtl = Math.max(Math.floor((expiresAt - Date.now()) / 1_000), 60);

    record.revokedAt = new Date().toISOString();
    await this.kv.put(this.sessionKey(sessionToken), record, remainingTtl);
  }

  async deleteSession(sessionToken: string): Promise<void> {
    await this.kv.delete(this.sessionKey(sessionToken));
  }

  // ── RFC 7591 Dynamic Client Registration ──────────────────────────────────

  async registerClient(
    redirectUris: string[],
    clientName?: string,
    environment?: EbayEnvironment
  ): Promise<ClientRecord> {
    const clientId = randomUUID();
    const record: ClientRecord = {
      clientId,
      redirectUris,
      clientName,
      createdAt: new Date().toISOString(),
      ...(environment ? { environment } : {}),
    };
    await this.kv.put(`client:${clientId}`, record);
    return record;
  }

  /**
   * Upserts a client record using a **caller-supplied** `clientId`.
   *
   * Used by the `/authorize` endpoint to auto-register trusted desktop MCP
   * clients (VS Code, Cursor, Windsurf, localhost loopback) that arrive at
   * `/authorize` without a prior `/register` call (e.g. because the in-memory
   * registration was lost between requests, or the client drives `/authorize`
   * directly).
   *
   * An existing record for `clientId` is overwritten only if the supplied
   * `redirectUri` is not already listed (additive merge otherwise).
   */
  /**
   * @param environment  Optional env to tag the client with.  When provided,
   *   the environment is persisted on the record so that the root /authorize
   *   endpoint can use it as a fallback even when no ?env= query param is
   *   present.  If the existing record already has a different environment
   *   the new value wins (e.g. re-registering via /sandbox/authorize should
   *   override a stale "production" tag).
   */
  async registerClientWithId(
    clientId: string,
    redirectUris: string[],
    clientName?: string,
    environment?: EbayEnvironment
  ): Promise<ClientRecord> {
    const existing = await this.kv.get<ClientRecord>(`client:${clientId}`);
    const now = new Date().toISOString();

    if (existing) {
      // Merge any new redirect URIs and update the env tag when provided.
      const merged = Array.from(new Set([...existing.redirectUris, ...redirectUris]));
      const updated: ClientRecord = {
        ...existing,
        redirectUris: merged,
        ...(environment ? { environment } : {}),
      };
      await this.kv.put(`client:${clientId}`, updated);
      return updated;
    }

    const record: ClientRecord = {
      clientId,
      redirectUris,
      clientName,
      createdAt: now,
      ...(environment ? { environment } : {}),
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
      expiresAt: secondsFromNow(AUTH_CODE_TTL_S),
    };
    await this.kv.put(`auth_code:${code}`, record, AUTH_CODE_TTL_S);
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
