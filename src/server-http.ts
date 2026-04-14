import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import axios from 'axios';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { EbaySellerApi } from '@/api/index.js';
import {
  getBaseUrl,
  getConfiguredEnvironment,
  getHostedOauthScopes,
  getEbayConfig,
  getOAuthAuthorizationUrl,
  getValidationRunnerUserId,
  validateCredentialsForEnvironment,
  ruNameToEnvironment,
  type EbayEnvironment,
} from '@/config/environment.js';
import { getVersion } from '@/utils/version.js';
import { serverLogger } from '@/utils/logger.js';
import { MultiUserAuthStore } from '@/auth/multi-user-store.js';
import {
  evaluateEbayResearchSessionExpiryCheck,
  getEbayResearchSessionAlertCallbackUrl,
  verifyQStashRequestSignature,
  type EbayResearchSessionExpiryCheckPayload,
} from '@/validation/providers/ebay-research-session-alerts.js';
import type {
  getToolDefinitions as GetToolDefinitionsFn,
  executeTool as ExecuteToolFn,
} from './tools/index.js';

const CONFIG = {
  host: process.env.MCP_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  oauthStartKey: process.env.OAUTH_START_KEY ?? '',
};

const authStore = new MultiUserAuthStore();
// Emit the concrete backend class so logs can never claim "memory" while
// actually using Cloudflare (or vice-versa).  This fires once on startup,
// after dotenv has already been loaded by the config/environment import.
console.log(`[auth-store] Active KV backend: ${authStore.backendName}`);

function getServerBaseUrl(): string {
  return CONFIG.publicBaseUrl || `http://localhost:${CONFIG.port}`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

function getValidationIdFromBody(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'validationId' in body &&
    typeof body.validationId === 'string'
  ) {
    return body.validationId;
  }
  return '';
}

function getRetryTimestampFromBody(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'timestamp' in body &&
    typeof body.timestamp === 'string'
  ) {
    const parsed = new Date(body.timestamp);
    if (Number.isFinite(parsed.getTime())) {
      return new Date(parsed.getTime() + 30 * 60 * 1000).toISOString();
    }
  }
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

function getAxiosFailureDebug(error: unknown): {
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
} {
  if (!axios.isAxiosError(error)) {
    return {
      responseStatus: null,
      responseBodyExcerpt: null,
    };
  }

  const responseStatus = error.response?.status ?? null;
  const rawBody: unknown = error.response?.data;

  if (rawBody === undefined) {
    return {
      responseStatus,
      responseBodyExcerpt: null,
    };
  }

  const bodyText = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2);

  return {
    responseStatus,
    responseBodyExcerpt: bodyText.slice(0, 500),
  };
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!CONFIG.adminApiKey) {
    res.status(500).json({ error: 'ADMIN_API_KEY is not configured' });
    return;
  }
  const header = req.headers['x-admin-api-key'];
  if (header !== CONFIG.adminApiKey) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function requireOauthStartKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!CONFIG.oauthStartKey) {
    next();
    return;
  }
  const header = req.headers['x-oauth-start-key'];
  const queryKey = typeof req.query.key === 'string' ? req.query.key : '';
  if (header !== CONFIG.oauthStartKey && queryKey !== CONFIG.oauthStartKey) {
    res.status(401).json({ error: 'unauthorized_oauth_start' });
    return;
  }
  next();
}

/**
 * Returns true when a redirect URI belongs to a well-known desktop / IDE
 * MCP client (VS Code, Cursor, Windsurf) or a localhost loopback.
 */
function isTrustedDesktopRedirectUri(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (
      u.protocol === 'vscode:' ||
      u.protocol === 'cursor:' ||
      u.protocol === 'windsurf:' ||
      u.protocol === 'claude:'
    ) {
      return true;
    }
    if (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1')
    ) {
      return true;
    }
  } catch {
    // Malformed URI – treat as untrusted
  }
  return false;
}

async function createUserScopedApi(
  userId: string,
  environment: EbayEnvironment
): Promise<EbaySellerApi> {
  const api = new EbaySellerApi(getEbayConfig(environment), { userId, environment });
  await api.initialize();
  return api;
}

// ── Shared MCP transport map (keyed by MCP session UUID) ─────────────────
// A single map is safe — session IDs are UUIDs with no env-specific uniqueness
// requirement.
const transports = new Map<string, StreamableHTTPServerTransport>();

function createApp(): express.Application {
  const app = express();
  app.disable('x-powered-by');
  const currentFilename = fileURLToPath(import.meta.url);
  const currentDirname = dirname(currentFilename);
  const projectRoot = join(currentDirname, '..');
  type RequestWithRawBody = express.Request & { rawBody?: string };

  app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'] }));
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString('utf8');
      },
    })
  );
  // OAuth token endpoint sends application/x-www-form-urlencoded per RFC 6749
  app.use(
    express.urlencoded({
      extended: false,
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(helmet({ xPoweredBy: false }));
  app.use('/icons', express.static(join(projectRoot, 'public', 'icons')));
  app.use('/callback-copy.js', express.static(join(projectRoot, 'public', 'callback-copy.js')));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const message = `${req.method} ${req.path} -> ${res.statusCode}`;
      const meta = {
        durationMs: Date.now() - start,
      };

      if (req.path === '/health' || req.path.endsWith('/validation/health')) {
        serverLogger.verbose(message, meta);
        return;
      }

      serverLogger.info(message, meta);
    });
    next();
  });

  const serverUrl = getServerBaseUrl();
  const iconBaseUrl = `${serverUrl}/icons`;

  // ── RFC 9728 – Path-based Protected Resource Metadata ────────────────────
  // Cline probes these URLs for MCP resources at /sandbox/mcp and /production/mcp.
  // RFC 9728 §3 defines the well-known URI as:
  //   /.well-known/oauth-protected-resource{path-to-resource}
  // We must serve these before the env routers so they are not caught by their
  // own /.well-known/... handler (which is relative to the router base path).

  app.get('/.well-known/oauth-protected-resource/sandbox/mcp', (_req, res) => {
    res.json({
      resource: `${serverUrl}/sandbox/mcp`,
      authorization_servers: [`${serverUrl}/sandbox`],
      scopes_supported: ['mcp'],
      resource_documentation: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
    });
  });

  app.get('/.well-known/oauth-protected-resource/production/mcp', (_req, res) => {
    res.json({
      resource: `${serverUrl}/production/mcp`,
      authorization_servers: [`${serverUrl}/production`],
      scopes_supported: ['mcp'],
      resource_documentation: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
    });
  });

  // Generic fallback: serves the default-env resource metadata.
  // Also satisfies clients that probe /.well-known/oauth-protected-resource
  // without a path suffix.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    const defaultEnv = getConfiguredEnvironment();
    res.json({
      resource: `${serverUrl}/${defaultEnv}/mcp`,
      authorization_servers: [`${serverUrl}/${defaultEnv}`],
      scopes_supported: ['mcp'],
      resource_documentation: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
    });
  });

  // ── RFC 8414 §3 – Path-based Authorization Server Metadata ───────────────
  // When Protected Resource Metadata says authorization_servers: ["…/sandbox"],
  // RFC 8414 §3 requires the auth server metadata to be fetchable at:
  //   /.well-known/oauth-authorization-server/sandbox   (NOT /sandbox/.well-known/…)
  //
  // Cline probes exactly this form. Without these routes it falls back to root
  // /authorize which silently defaults to production.

  app.get('/.well-known/oauth-authorization-server/sandbox', (_req, res) => {
    const base = `${serverUrl}/sandbox`;
    // authorization_endpoint uses the ROOT /authorize with ?env=sandbox so that
    // MCP clients (like Cline) that strip the path prefix from the issuer URL
    // still land on the correct environment — the ?env= query param is
    // preserved through URL construction and picked up by resolveEnv().
    // token/registration still use the env-scoped path.
    res.json({
      issuer: base,
      authorization_endpoint: `${serverUrl}/authorize?env=sandbox`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  app.get('/.well-known/oauth-authorization-server/production', (_req, res) => {
    const base = `${serverUrl}/production`;
    res.json({
      issuer: base,
      authorization_endpoint: `${serverUrl}/authorize?env=production`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // ── Root index / health ───────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.json({
      name: 'ebay-mcp-remote-edition',
      version: getVersion(),
      mode: 'multi-user-hosted',
      description:
        'Hosted MCP + OAuth server for eBay APIs, including validation routes and internal eBay Research session-expiry alert callbacks.',
      mcp_endpoints: {
        sandbox: `${serverUrl}/sandbox/mcp`,
        production: `${serverUrl}/production/mcp`,
        default: `${serverUrl}/mcp`,
      },
      oauth_start: {
        sandbox: `${serverUrl}/sandbox/oauth/start`,
        production: `${serverUrl}/production/oauth/start`,
      },
      validation_endpoints: {
        run: `${serverUrl}/validation/run`,
      },
      internal_endpoints: {
        ebayResearchSessionExpiryCheck: `${serverUrl}/internal/ebay-research/check-session-expiry`,
      },
    });
  });

  app.get('/health', (req, res) => {
    const healthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: getVersion(),
    };

    serverLogger.verbose('Health response emitted', {
      path: req.originalUrl,
      status: healthResponse.status,
      timestamp: healthResponse.timestamp,
      version: healthResponse.version,
    });

    res.json(healthResponse);
  });

  app.post('/internal/ebay-research/check-session-expiry', async (req, res) => {
    const rawBody =
      (req as RequestWithRawBody).rawBody ??
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    const signatureHeader = req.headers['upstash-signature'];
    const signature = typeof signatureHeader === 'string' ? signatureHeader : null;
    const expectedUrl = getEbayResearchSessionAlertCallbackUrl();

    try {
      verifyQStashRequestSignature({
        signature,
        rawBody,
        url: expectedUrl,
      });
    } catch (error) {
      serverLogger.warn('[eBayResearchSessionAlerts] Rejected callback with invalid signature', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(401).json({
        status: 'error',
        message: 'invalid qstash signature',
      });
      return;
    }

    const payload = req.body as EbayResearchSessionExpiryCheckPayload;

    try {
      const result = await evaluateEbayResearchSessionExpiryCheck(payload);
      res.status(result.status === 'error' ? 500 : 200).json(result);
    } catch (error) {
      serverLogger.error('[eBayResearchSessionAlerts] Callback evaluation failed', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });
      res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Admin routes ──────────────────────────────────────────────────────────

  app.get('/admin/session/:sessionToken', requireAdmin, async (req, res) => {
    const tokenParam = req.params.sessionToken;
    const sessionToken = typeof tokenParam === 'string' ? tokenParam : tokenParam[0];
    const session = await authStore.getSession(sessionToken);
    if (!session) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(session);
  });

  app.get('/whoami', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_session_token' });
      return;
    }
    const sessionToken = authHeader.slice('Bearer '.length).trim();
    const session = await authStore.getSession(sessionToken);
    if (!session || session.revokedAt) {
      res.status(401).json({ error: 'invalid_session_token' });
      return;
    }
    res.json({
      userId: session.userId,
      environment: session.environment,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastUsedAt: session.lastUsedAt,
      revokedAt: session.revokedAt ?? null,
    });
  });

  app.post('/admin/session/:sessionToken/revoke', requireAdmin, async (req, res) => {
    const tokenParam = req.params.sessionToken;
    const sessionToken = typeof tokenParam === 'string' ? tokenParam : tokenParam[0];
    await authStore.revokeSession(sessionToken);
    res.json({ ok: true, revoked: true });
  });

  app.delete('/admin/session/:sessionToken', requireAdmin, async (req, res) => {
    const tokenParam = req.params.sessionToken;
    const sessionToken = typeof tokenParam === 'string' ? tokenParam : tokenParam[0];
    await authStore.deleteSession(sessionToken);
    res.json({ ok: true, deleted: true });
  });

  // ── Single OAuth callback (registered with eBay — must be one fixed URL) ─
  // The environment is recovered from the state record, not the URL path.
  app.get('/oauth/callback', async (req, res) => {
    await handleOAuthCallback(req, res, serverUrl);
  });

  // ── Mount env-scoped route trees ─────────────────────────────────────────
  // Each tree hard-binds its environment so no ?env= query param is needed.
  app.use('/sandbox', mountEnvRouter('sandbox', serverUrl, iconBaseUrl));
  app.use('/production', mountEnvRouter('production', serverUrl, iconBaseUrl));

  // ── Root / backward-compat MCP routes (env resolved from ?env= or EBAY_ENVIRONMENT) ─
  app.use(mountEnvRouter(null, serverUrl, iconBaseUrl));

  return app;
}

// ── Environment-scoped router factory ────────────────────────────────────
/**
 * Creates an Express router with all MCP OAuth 2.1 + MCP endpoints for a
 * specific environment.
 *
 * @param hardcodedEnv  `'sandbox'` | `'production'` to hard-bind, or `null`
 *                      for the legacy auto-detect behaviour (reads `?env=` or
 *                      `EBAY_ENVIRONMENT`).
 * @param serverUrl     Canonical server origin, e.g. `https://my.host.com`.
 * @param iconBaseUrl   Full URL prefix for icon assets.
 */
function mountEnvRouter(
  hardcodedEnv: EbayEnvironment | null,
  serverUrl: string,
  iconBaseUrl: string
): express.Router {
  const router = express.Router();

  // The base URL that MCP clients will use for this router tree.
  // e.g. "https://my.host.com/sandbox" or "https://my.host.com" (root).
  const prefix = hardcodedEnv ?? '';
  const routeBaseUrl = hardcodedEnv ? `${serverUrl}/${hardcodedEnv}` : serverUrl;

  function resolveEnv(req: express.Request): EbayEnvironment {
    if (hardcodedEnv) return hardcodedEnv;
    const q = req.query as Record<string, string>;
    if (q.env === 'sandbox' || q.env === 'production') return q.env;

    // For root router, detect environment from available signals in priority order:
    //
    //   1. `resource` query param (RFC 9728) — MCP clients like Cline include the
    //      full target MCP URL, e.g. resource=https://host/sandbox/mcp, which
    //      encodes the env directly in its path.
    //
    //   2. Per-env RuNames (EBAY_SANDBOX_RUNAME / EBAY_PRODUCTION_RUNAME) via
    //      -SB- / -PR- segment — if only ONE is configured, it's definitive.
    //      If BOTH are configured they conflict; skip to next step.
    //
    //   3. Generic RuName (EBAY_RUNAME / legacy EBAY_REDIRECT_URI) to disambiguate
    //      when both or neither env-specific vars are set.
    //
    //   4. EBAY_ENVIRONMENT env var — last resort only.

    // Step 1: resource param (most reliable for RFC 9728-aware clients).
    const resourceParam = q.resource;
    if (resourceParam) {
      if (resourceParam.includes('/sandbox/') || resourceParam.endsWith('/sandbox')) {
        return 'sandbox';
      }
      if (resourceParam.includes('/production/') || resourceParam.endsWith('/production')) {
        return 'production';
      }
    }

    // Step 2: per-env RuName detection.
    const sandboxRuName = process.env.EBAY_SANDBOX_RUNAME ?? process.env.EBAY_SANDBOX_REDIRECT_URI;
    const productionRuName =
      process.env.EBAY_PRODUCTION_RUNAME ?? process.env.EBAY_PRODUCTION_REDIRECT_URI;
    const genericRuName = process.env.EBAY_RUNAME ?? process.env.EBAY_REDIRECT_URI;

    const sandboxDetected = ruNameToEnvironment(sandboxRuName);
    const productionDetected = ruNameToEnvironment(productionRuName);

    if (sandboxDetected && !productionDetected) return 'sandbox';
    if (productionDetected && !sandboxDetected) return 'production';

    // Step 3: generic RuName to disambiguate when both/neither env-specific are set.
    const genericDetected = ruNameToEnvironment(genericRuName);
    if (genericDetected) return genericDetected;

    // Step 4: final fallback.
    return getConfiguredEnvironment();
  }

  router.post('/validation/run', requireAdmin, async (req, res) => {
    const environment = resolveEnv(req);
    const validationRunnerUserId = getValidationRunnerUserId(environment);

    if (!validationRunnerUserId) {
      res.status(500).json({
        status: 'error',
        validationId: getValidationIdFromBody(req.body),
        errorCode: 'VALIDATION_USER_NOT_CONFIGURED',
        message: `No validation runner user is configured for ${environment}`,
        retryable: false,
        nextCheckAt: null,
      });
      return;
    }

    const storedTokens = await authStore.getUserTokens(validationRunnerUserId, environment);
    if (!storedTokens?.tokenData) {
      res.status(500).json({
        status: 'error',
        validationId: getValidationIdFromBody(req.body),
        errorCode: 'VALIDATION_USER_TOKENS_MISSING',
        message: `Stored refresh-token-backed credentials were not found for validation user ${validationRunnerUserId} in ${environment}`,
        retryable: false,
        nextCheckAt: null,
      });
      return;
    }

    try {
      const api = await createUserScopedApi(validationRunnerUserId, environment);
      const { runValidation } = await import('./validation/run-validation.js');
      const result = await runValidation(api, req.body);

      if (result.status === 'error') {
        res.status(500).json(result);
        return;
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        validationId: getValidationIdFromBody(req.body),
        errorCode: 'VALIDATION_ROUTE_ERROR',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        nextCheckAt: getRetryTimestampFromBody(req.body),
      });
    }
  });

  router.get('/validation/health', requireAdmin, async (req, res) => {
    const environment = resolveEnv(req);
    const validationRunnerUserId = getValidationRunnerUserId(environment);
    const storedTokens = validationRunnerUserId
      ? await authStore.getUserTokens(validationRunnerUserId, environment)
      : null;
    const socialConfig = {
      hasTwitterBearerToken: Boolean(process.env.TWITTER_BEARER_TOKEN?.trim()),
      hasYoutubeApiKey: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
      hasRedditUserAgent: Boolean(process.env.REDDIT_USER_AGENT?.trim()),
    };

    let authenticated = false;
    let authError: string | null = null;
    let tokenStatus: ReturnType<EbaySellerApi['getTokenInfo']> | null = null;
    let authDebug: {
      tokenEndpoint: string;
      environment: 'production' | 'sandbox';
      hasClientId: boolean;
      hasClientSecret: boolean;
      hasRefreshToken: boolean;
      hasAccessToken: boolean;
      hasRedirectUri: boolean;
      configuredMarketplaceId: string;
      configuredContentLanguage: string;
      refreshTokenExpiry?: number;
      accessTokenExpiry?: number;
      source?:
        | 'stored_user_tokens'
        | 'env_refresh_token_fallback'
        | 'authorization_code_exchange'
        | 'manual_set_user_tokens';
      responseStatus?: number | null;
      responseBodyExcerpt?: string | null;
    } | null = null;

    if (validationRunnerUserId && storedTokens?.tokenData) {
      try {
        const api = await createUserScopedApi(validationRunnerUserId, environment);
        const oauthClient = api.getAuthClient().getOAuthClient();
        const config = api.getAuthClient().getConfig();
        authDebug = {
          ...oauthClient.getAuthDebugInfo(),
          configuredMarketplaceId: config.marketplaceId ?? '',
          configuredContentLanguage: config.contentLanguage ?? '',
        };
        await api.getAuthClient().getOAuthClient().getAccessToken();
        authenticated = true;
        tokenStatus = api.getTokenInfo();
      } catch (error) {
        authError = error instanceof Error ? error.message : String(error);
        const failureDebug = getAxiosFailureDebug(error);
        authDebug = authDebug
          ? {
              ...authDebug,
              responseStatus: failureDebug.responseStatus,
              responseBodyExcerpt: failureDebug.responseBodyExcerpt,
            }
          : null;
        serverLogger.error('Validation health auth check failed', {
          environment,
          validationRunnerUserId,
          tokenEndpoint: authDebug?.tokenEndpoint ?? null,
          responseStatus: failureDebug.responseStatus,
          responseBodyExcerpt: failureDebug.responseBodyExcerpt,
          authError,
        });
      }
    }

    const healthResponse = {
      status: authenticated ? 'ok' : 'degraded',
      environment,
      validationRunnerUserId,
      hasStoredTokens: !!storedTokens?.tokenData,
      authenticated,
      tokenStatus,
      authDebug,
      providers: {
        ebay: { available: true, implemented: true, confidence: 'medium' },
        social: { available: false, implemented: false, confidence: 'low' },
        chart: { available: false, implemented: false, confidence: 'low' },
        socialConfig,
      },
      ...(authError ? { authError } : {}),
    };

    serverLogger.info('Validation health response emitted', {
      environment,
      path: req.originalUrl,
      status: healthResponse.status,
      version: getVersion(),
      hasSocialConfigAtRoot: Object.prototype.hasOwnProperty.call(healthResponse, 'socialConfig'),
      hasSocialConfigUnderProviders: Object.prototype.hasOwnProperty.call(
        healthResponse.providers,
        'socialConfig'
      ),
      providerKeys: Object.keys(healthResponse.providers),
      socialConfig,
    });

    res.json(healthResponse);
  });

  // ── RFC 8414 – Authorization Server Metadata ──────────────────────────
  // For env-scoped routers: endpoints are relative to the env base URL.
  // For the ROOT router: endpoints are relative to the DEFAULT environment's
  // base URL (not root). This ensures that MCP clients that cached root
  // auth-server discovery (e.g. Cline) see env-specific authorize/token/
  // register URLs and update their cached endpoints on the next request.
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    // env-scoped: use as-is; root: redirect to the configured default env sub-path
    const endpointBase = hardcodedEnv ? routeBaseUrl : `${serverUrl}/${getConfiguredEnvironment()}`;
    res.json({
      issuer: routeBaseUrl,
      authorization_endpoint: `${endpointBase}/authorize`,
      token_endpoint: `${endpointBase}/token`,
      registration_endpoint: `${endpointBase}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // ── RFC 7591 – Dynamic Client Registration ────────────────────────────
  router.post('/register', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const redirectUris = body.redirect_uris;
    const clientName = typeof body.client_name === 'string' ? body.client_name : undefined;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
      });
      return;
    }

    const uris = redirectUris as string[];
    // Tag the registered client with the env so that root /authorize can use
    // client.environment as a fallback when no ?env= param is present.
    const client = await authStore.registerClient(uris, clientName, hardcodedEnv ?? undefined);
    serverLogger.info(`[${prefix || 'root'}/register] MCP client registered`, {
      clientId: client.clientId,
      redirectUris: client.redirectUris,
    });
    res.status(201).json({
      client_id: client.clientId,
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  // ── RFC 6749 – Authorization Endpoint (PKCE required) ────────────────
  router.get('/authorize', requireOauthStartKey, async (req, res) => {
    try {
      const q = req.query as Record<string, string>;
      const {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: responseType,
        state: mcpState,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
      } = q;
      // Environment resolution (in priority order):
      //   1. URL path prefix (/sandbox, /production) → authoritative  [hardcodedEnv]
      //   2. Explicit ?env= query param
      //   3. ?resource param (RFC 9728 — full MCP URL encodes env in its path)
      //   4. RuName -SB-/-PR- segment / EBAY_ENVIRONMENT fallback (see resolveEnv)
      const envSource = hardcodedEnv
        ? 'path'
        : q.env === 'sandbox' || q.env === 'production'
          ? 'query'
          : q.resource && (q.resource.includes('/sandbox/') || q.resource.includes('/production/'))
            ? 'resource'
            : 'runame';
      let environment = resolveEnv(req);

      serverLogger.info(`[${prefix || 'root'}/authorize] Request received`, {
        clientId,
        redirectUri,
        responseType,
        hasPkce: !!codeChallenge,
        pkceMethod: codeChallengeMethod,
        environment,
        envSource,
        hasMcpState: !!mcpState,
      });

      if (responseType !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }
      if (!clientId) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'client_id is required' });
        return;
      }

      let client = await authStore.getClient(clientId);

      // For root router (hardcodedEnv = null): if the client was previously
      // registered through an env-scoped path (e.g. /sandbox/register), use
      // that env instead of the generic fallback — even if ?env= was not sent.
      // This fixes the case where Cline has cached root /authorize but the
      // client record was tagged as sandbox from an earlier discovery pass.
      if (!hardcodedEnv && client?.environment) {
        if (environment !== client.environment) {
          serverLogger.info(`[root/authorize] Overriding env from client registration`, {
            clientId,
            resolvedEnv: environment,
            clientEnv: client.environment,
          });
          environment = client.environment;
        }
      }

      if (!client) {
        if (redirectUri && isTrustedDesktopRedirectUri(redirectUri)) {
          serverLogger.info(
            `[${prefix || 'root'}/authorize] Auto-registering trusted desktop MCP client`,
            { clientId, redirectUri }
          );
          // Tag the new client with the already-resolved env so subsequent root
          // /authorize calls also land on the correct env without re-discovery.
          client = await authStore.registerClientWithId(
            clientId,
            [redirectUri],
            undefined,
            environment
          );
        } else {
          serverLogger.warn(`[${prefix || 'root'}/authorize] Rejected: unknown client_id`, {
            clientId,
            redirectUri,
          });
          res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
          return;
        }
      }
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri not registered for this client',
        });
        return;
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'PKCE with S256 code_challenge is required',
        });
        return;
      }

      const ebayConfig = getEbayConfig(environment);
      if (!ebayConfig.clientId || !ebayConfig.clientSecret || !ebayConfig.redirectUri) {
        res.status(500).json({
          error: 'server_error',
          error_description: `Missing eBay configuration for ${environment}`,
        });
        return;
      }

      // Validate that the loaded credentials (RuName segment) actually match the
      // requested environment.  This is the authoritative check — if the RuName
      // contains -PR- but the request is for sandbox (or vice-versa), we must
      // fail fast rather than silently issuing tokens for the wrong environment.
      const credCheck = validateCredentialsForEnvironment(environment);
      serverLogger.info(`[${prefix || 'root'}/authorize] Credential check`, {
        environment,
        envSource,
        ruName: ebayConfig.redirectUri,
        ruNameDetectedEnv: credCheck.detectedEnv,
        credentialValid: credCheck.valid,
      });
      if (!credCheck.valid) {
        serverLogger.error(`[${prefix || 'root'}/authorize] RuName/environment mismatch`, {
          error: credCheck.error,
        });
        res.status(500).json({
          error: 'server_misconfiguration',
          error_description: credCheck.error,
        });
        return;
      }

      const stateRecord = await authStore.createOAuthState(environment, undefined, {
        mcpClientId: clientId,
        mcpRedirectUri: redirectUri,
        mcpState,
        mcpCodeChallenge: codeChallenge,
        mcpCodeChallengeMethod: codeChallengeMethod,
      });

      const oauthUrl = getOAuthAuthorizationUrl(
        ebayConfig.clientId,
        ebayConfig.redirectUri,
        environment,
        getHostedOauthScopes(environment),
        undefined,
        stateRecord.state
      );
      serverLogger.info(`[${prefix || 'root'}/authorize] Redirecting to eBay OAuth`, {
        state: stateRecord.state,
        environment,
      });
      res.redirect(oauthUrl);
    } catch (error) {
      serverLogger.error(`[${prefix || 'root'}/authorize] Unhandled error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'server_error',
        error_description: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── RFC 6749 – Token Endpoint ─────────────────────────────────────────
  router.post('/token', async (req, res) => {
    // Entry-level log fires before ANY validation so we can confirm whether
    // Cline's token request reaches the server at all.  If this log never
    // appears after a successful vscode:// deep-link redirect, the request
    // is being dropped before it reaches the server (TLS trust issue, wrong
    // URL, or the deep link is silently swallowed by VS Code).
    serverLogger.info(`[${prefix || 'root'}/token] Request received`, {
      contentType: req.headers['content-type'],
      origin: req.headers.origin,
      hasBody: !!req.body,
    });

    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Request body is missing or unparseable.',
      });
      return;
    }

    const body = req.body as Record<string, string>;
    const {
      grant_type: grantType,
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    } = body;

    if (grantType !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      return;
    }

    const authCode = await authStore.consumeAuthCode(code);
    if (!authCode) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      });
      return;
    }

    serverLogger.info(`[${prefix || 'root'}/token] Auth code found`, {
      storedClientId: authCode.clientId,
      providedClientId: clientId,
    });

    if (authCode.clientId !== clientId) {
      res.status(400).json({ error: 'invalid_client', error_description: 'client_id mismatch' });
      return;
    }
    if (authCode.redirectUri !== redirectUri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    if (!codeVerifier) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'code_verifier is required' });
      return;
    }

    const expectedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      res
        .status(400)
        .json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    const session = await authStore.createSession(authCode.userId, authCode.environment);
    serverLogger.info(`[${prefix || 'root'}/token] Session created`, {
      userId: authCode.userId,
      environment: authCode.environment,
      expiresAt: session.expiresAt,
    });
    res.json({
      access_token: session.sessionToken,
      token_type: 'bearer',
      scope: 'mcp',
    });
  });

  // ── OAuth start (browser-initiated non-MCP flow) ──────────────────────
  router.get('/oauth/start', requireOauthStartKey, async (req, res) => {
    try {
      const environment = resolveEnv(req);
      const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
      const ebayConfig = getEbayConfig(environment);
      if (!ebayConfig.clientId || !ebayConfig.clientSecret || !ebayConfig.redirectUri) {
        res.status(500).json({ error: `Missing eBay configuration for ${environment}` });
        return;
      }
      const stateRecord = await authStore.createOAuthState(environment, returnTo);
      const oauthUrl = getOAuthAuthorizationUrl(
        ebayConfig.clientId,
        ebayConfig.redirectUri,
        environment,
        getHostedOauthScopes(environment),
        undefined,
        stateRecord.state
      );
      res.redirect(oauthUrl);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ── MCP endpoint ──────────────────────────────────────────────────────

  const authenticateSession = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    const requestedEnv = resolveEnv(req);

    const sendAuthorizationRequired = (
      reason: 'missing_session_token' | 'invalid_session_token'
    ): void => {
      const oauthStartPath = `${routeBaseUrl}/oauth/start`;
      const oauthUrl = new URL(oauthStartPath);
      // Only append ?env= for the root (auto) router; env-scoped routers are self-describing.
      if (!hardcodedEnv) {
        oauthUrl.searchParams.set('env', requestedEnv);
      }
      if (CONFIG.oauthStartKey) {
        oauthUrl.searchParams.set('key', CONFIG.oauthStartKey);
      }

      // RFC 9728 §5.1 / RFC 6750: include resource_metadata in WWW-Authenticate
      // so that MCP clients (Cline, Claude Desktop, etc.) can discover the
      // correct env-scoped authorization server without probing well-known URLs.
      // The path-based well-known URI for a resource at /sandbox/mcp is
      //   /.well-known/oauth-protected-resource/sandbox/mcp
      // For the root MCP path we fall back to the generic well-known endpoint.
      const resourcePath = req.path; // e.g. "" (when router is at /sandbox)
      const fullResourcePath = hardcodedEnv ? `/${hardcodedEnv}${resourcePath}` : resourcePath;
      // Normalise: strip trailing slashes, ensure it does not double-encode
      const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource${fullResourcePath.replace(/\/$/, '')}`;

      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl}"`
      );

      if (req.method === 'GET') {
        res.redirect(oauthUrl.toString());
        return;
      }

      res.status(401).json({
        error: reason,
        authorization_required: true,
        environment: requestedEnv,
        authorization_url: oauthUrl.toString(),
        resource_metadata: resourceMetadataUrl,
        message:
          'No valid hosted session token was provided. Complete the browser OAuth flow using authorization_url, then retry with Authorization: Bearer <session-token>.',
      });
    };

    if (!authHeader?.startsWith('Bearer ')) {
      sendAuthorizationRequired('missing_session_token');
      return;
    }
    const sessionToken = authHeader.slice('Bearer '.length).trim();

    const session = await authStore.getSession(sessionToken);
    if (!session || session.revokedAt) {
      sendAuthorizationRequired('invalid_session_token');
      return;
    }
    await authStore.touchSession(sessionToken);
    (
      req as express.Request & {
        userContext?: { userId: string; environment: EbayEnvironment; sessionToken: string };
      }
    ).userContext = {
      userId: session.userId,
      environment: session.environment,
      sessionToken,
    };
    next();
  };

  async function createMcpServer(userId: string, environment: EbayEnvironment): Promise<McpServer> {
    let getToolDefinitions: typeof GetToolDefinitionsFn;
    let executeTool: typeof ExecuteToolFn;

    try {
      ({ getToolDefinitions, executeTool } = await import('./tools/index.js'));
    } catch (error) {
      serverLogger.error('Failed to import MCP tool registry', {
        userId,
        environment,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const api = await createUserScopedApi(userId, environment);
    const server = new McpServer({
      name: 'ebay-mcp-remote-edition',
      version: getVersion(),
      title: 'eBay MCP Server',
      websiteUrl: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
      icons: [
        { src: `${iconBaseUrl}/16x16.png`, mimeType: 'image/png', sizes: ['16x16'] },
        { src: `${iconBaseUrl}/32x32.png`, mimeType: 'image/png', sizes: ['32x32'] },
        { src: `${iconBaseUrl}/48x48.png`, mimeType: 'image/png', sizes: ['48x48'] },
      ],
    });

    const tools = getToolDefinitions();
    for (const toolDef of tools) {
      try {
        server.registerTool(
          toolDef.name,
          { description: toolDef.description, inputSchema: toolDef.inputSchema },
          async (args: Record<string, unknown>) => {
            try {
              const result = await executeTool(api, toolDef.name, args);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      { error: error instanceof Error ? error.message : String(error) },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              };
            }
          }
        );
      } catch (error) {
        serverLogger.error('Failed to register MCP tool', {
          toolName: toolDef.name,
          userId,
          environment,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return server;
  }

  const mcpPostHandler = async (req: express.Request, res: express.Response): Promise<void> => {
    const userContext = (
      req as express.Request & { userContext?: { userId: string; environment: EbayEnvironment } }
    ).userContext;
    if (!userContext) {
      res.status(401).json({ error: 'missing_user_context' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      try {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            serverLogger.info('New MCP session initialized', {
              sessionId: newSessionId,
              userId: userContext.userId,
              environment: userContext.environment,
            });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        const server = await createMcpServer(userContext.userId, userContext.environment);
        await server.connect(transport);
      } catch (error) {
        serverLogger.error('Failed to initialize MCP session', {
          userId: userContext.userId,
          environment: userContext.environment,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Failed to initialize MCP session',
          },
          id: null,
        });
        return;
      }
    } else {
      serverLogger.warn('Rejected MCP request without valid transport session', {
        hasSessionId: !!sessionId,
        sessionId,
        isInitialize: isInitializeRequest(req.body),
        userId: userContext.userId,
        environment: userContext.environment,
      });
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  };

  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response
  ): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res
        .status(400)
        .json({ error: 'invalid_session', error_description: 'Invalid or missing session ID' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  };

  router.post('/mcp', authenticateSession, mcpPostHandler);
  router.get('/mcp', authenticateSession, handleSessionRequest);
  router.delete('/mcp', authenticateSession, handleSessionRequest);

  return router;
}

// ── eBay OAuth callback ───────────────────────────────────────────────────
// This is mounted once at root because eBay requires a single registered
// redirect URI per app. The environment is recovered from the stored state.
async function handleOAuthCallback(
  req: express.Request,
  res: express.Response,
  serverUrl: string
): Promise<void> {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const oauthError = typeof req.query.error === 'string' ? req.query.error : undefined;
    const errorDescription =
      typeof req.query.error_description === 'string' ? req.query.error_description : undefined;

    serverLogger.info('[oauth/callback] Received', {
      hasCode: !!code,
      hasState: !!state,
      oauthError,
    });

    if (oauthError) {
      res
        .status(400)
        .send(`<h1>OAuth failed</h1><p>${htmlEscape(errorDescription ?? oauthError)}</p>`);
      return;
    }
    if (!code) {
      res.status(400).send('<h1>Missing authorization code</h1>');
      return;
    }

    if (!state) {
      serverLogger.warn('[oauth/callback] Missing OAuth state in callback');
      res
        .status(400)
        .send(
          "<h1>Missing OAuth state</h1><p>Restart the OAuth flow from this server's /oauth/start or /authorize endpoint.</p>"
        );
      return;
    }

    const stateRecord = await authStore.getOAuthState(state);
    if (!stateRecord) {
      serverLogger.warn('[oauth/callback] OAuth state not found or expired', { state });
      res.status(400).send('<h1>Invalid or expired OAuth state</h1>');
      return;
    }

    const environment: EbayEnvironment = stateRecord.environment;
    serverLogger.info('[oauth/callback] State resolved', {
      environment,
      isMcpFlow: !!(stateRecord.mcpClientId && stateRecord.mcpRedirectUri),
    });

    const ebayConfig = getEbayConfig(environment);
    serverLogger.info('[oauth/callback] Prepared eBay token exchange', {
      environment,
      tokenBaseUrl: getBaseUrl(environment),
      clientIdPrefix: ebayConfig.clientId ? `${ebayConfig.clientId.slice(0, 12)}...` : '(missing)',
      ruName: ebayConfig.redirectUri ?? '(missing)',
    });

    const userId = randomUUID();
    const api = await createUserScopedApi(userId, environment);
    const oauthClient = api.getAuthClient().getOAuthClient();
    serverLogger.info('[oauth/callback] Exchanging code for eBay tokens', { userId });
    const tokenData = await oauthClient.exchangeCodeForToken(code);
    await authStore.deleteOAuthState(state);
    serverLogger.info('[oauth/callback] eBay token exchange successful', {
      userId,
      hasScope: !!tokenData.scope,
    });

    // ── MCP OAuth flow: redirect back to the registered MCP client ────────
    if (stateRecord?.mcpClientId && stateRecord.mcpRedirectUri && stateRecord.mcpCodeChallenge) {
      const authCodeRecord = await authStore.createAuthCode(
        stateRecord.mcpClientId,
        stateRecord.mcpRedirectUri,
        stateRecord.mcpCodeChallenge,
        stateRecord.mcpCodeChallengeMethod ?? 'S256',
        userId,
        environment
      );
      const redirectUrl = new URL(stateRecord.mcpRedirectUri);
      redirectUrl.searchParams.set('code', authCodeRecord.code);
      if (stateRecord.mcpState) {
        redirectUrl.searchParams.set('state', stateRecord.mcpState);
      }
      const finalRedirectUrl = redirectUrl.toString();
      serverLogger.info('[oauth/callback] MCP OAuth flow complete, redirecting to client', {
        clientId: stateRecord.mcpClientId,
        userId,
        authCodePrefix: authCodeRecord.code.substring(0, 8),
        expiresAt: authCodeRecord.expiresAt,
        // Full URL logged so we can verify vscode:// deep-link format exactly.
        // NOTE: contains auth code — treat as sensitive, rotate immediately on exposure.
        redirectUrl: finalRedirectUrl,
      });

      // ── Custom-scheme redirect (vscode://, cursor://, etc.) ──────────────
      // Browsers (Chrome 91+, Safari) block plain HTTP 302 → custom-scheme
      // redirects without an explicit user gesture, causing the vscode:// URI
      // to be silently swallowed before VS Code ever receives the deep link.
      //
      // Fix: serve an HTML page that uses window.location.href (page-level
      // navigation; browsers allow this) and shows a manual button fallback.
      // The page also shows a "close this tab" message after the redirect so
      // the user knows the flow completed.
      const isCustomScheme = redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:';

      if (isCustomScheme) {
        const safeFinalUrl = htmlEscape(finalRedirectUrl);
        res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Opening in VS Code…</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 80px auto; text-align: center; line-height: 1.6; color: #111827; padding: 0 16px; }
      .btn { display: inline-block; background: #111827; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 10px; font-size: 1rem; margin-top: 20px; }
      .btn:hover { background: #1f2937; }
      .muted { color: #6b7280; font-size: .9rem; margin-top: 24px; }
    </style>
  </head>
  <body>
    <h2>eBay authentication complete ✓</h2>
    <p>Opening VS Code to finish connecting…</p>
    <a class="btn" href="${safeFinalUrl}" id="open-link">Open in VS Code</a>
    <p class="muted">If VS Code does not open automatically, click the button above.<br>You may close this tab once VS Code activates.</p>
    <script>
      // Give the page a moment to render, then navigate.
      // window.location.href (user-initiated via script on page load) is
      // allowed by Chrome/Safari for custom URI schemes.
      setTimeout(function() {
        window.location.href = ${JSON.stringify(finalRedirectUrl)};
      }, 300);
    </script>
  </body>
</html>`);
        return;
      }

      // For http:// / https:// redirect URIs (e.g. localhost loopback), a
      // plain 302 is fine and is the standard OAuth response.
      res.redirect(finalRedirectUrl);
      return;
    }

    // ── Non-MCP flow: show tokens page ────────────────────────────────────
    serverLogger.info('[oauth/callback] Non-MCP flow: creating hosted session', { userId });
    const session = await authStore.createSession(userId, environment);

    res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>eBay MCP Connected</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; max-width: 760px; margin: 40px auto; line-height: 1.5; padding: 0 16px; }
      .card { background: #f7f7f8; padding: 16px; border-radius: 10px; margin: 16px 0; }
      pre { white-space: pre-wrap; word-break: break-all; background: #fff; padding: 14px; border-radius: 8px; border: 1px solid #e5e7eb; }
      .copy-btn { background: #111827; color: white; border: none; border-radius: 8px; padding: 10px 14px; cursor: pointer; transition: transform 120ms ease, opacity 120ms ease, background 120ms ease; }
      .copy-btn:hover { background: #1f2937; }
      .copy-btn:active { transform: scale(0.97); opacity: 0.92; }
      .copy-status { margin-left: 12px; color: #065f46; font-weight: 600; }
      .muted { color: #6b7280; }
      a { color: #2563eb; }
    </style>
    <script src="/callback-copy.js" defer></script>
  </head>
  <body>
    <h1>eBay account connected ✓</h1>
    <p>Your <strong>${htmlEscape(environment)}</strong> account has been connected successfully.</p>
    <p>Session expires: <strong>${htmlEscape(session.expiresAt)}</strong></p>

    <h2>① Session token — paste as Bearer token in your MCP client</h2>
    <div class="card">
      <pre id="session-token">${htmlEscape(session.sessionToken)}</pre>
      <button class="copy-btn" data-copy-source="session-token" data-copy-status="st-status">Copy</button><span id="st-status" class="copy-status"></span>
      <p class="muted">Set as <code>EBAY_SESSION_TOKEN</code> in your server env to survive restarts.</p>
    </div>

    <h2>② eBay user access token</h2>
    <div class="card">
      <pre id="access-token">${htmlEscape(tokenData.access_token)}</pre>
      <button class="copy-btn" data-copy-source="access-token" data-copy-status="at-status">Copy</button><span id="at-status" class="copy-status"></span>
      <p class="muted">Set as <code>EBAY_USER_ACCESS_TOKEN</code> in your server env (optional — auto-refreshed from refresh token).</p>
    </div>

    <h2>③ eBay user refresh token</h2>
    <div class="card">
      <pre id="refresh-token">${htmlEscape(tokenData.refresh_token ?? '')}</pre>
      <button class="copy-btn" data-copy-source="refresh-token" data-copy-status="rt-status">Copy</button><span id="rt-status" class="copy-status"></span>
      <p class="muted">Set as <code>EBAY_USER_REFRESH_TOKEN</code> in your server env. The server uses this to keep the access token fresh automatically.</p>
    </div>

    <div class="card">
      <p><strong>After copying, add these 3 lines to your server env and restart:</strong></p>
      <pre>EBAY_SESSION_TOKEN=${htmlEscape(session.sessionToken)}
EBAY_USER_ACCESS_TOKEN=${htmlEscape(tokenData.access_token)}
EBAY_USER_REFRESH_TOKEN=${htmlEscape(tokenData.refresh_token ?? '')}</pre>
    </div>

    <p><strong>MCP endpoints:</strong></p>
    <ul>
      <li>Sandbox: <code>${htmlEscape(`${serverUrl}/sandbox/mcp`)}</code></li>
      <li>Production: <code>${htmlEscape(`${serverUrl}/production/mcp`)}</code></li>
    </ul>
    <p><strong>Scopes granted:</strong> ${htmlEscape(tokenData.scope ?? 'Not returned by eBay in token response')}</p>
    <p class="muted">Keep these tokens private. Refresh tokens are valid for ~18 months.</p>
  </body>
</html>`);
  } catch (error) {
    serverLogger.error('[oauth/callback] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res
      .status(500)
      .send(
        `<h1>OAuth callback failed</h1><pre>${htmlEscape(error instanceof Error ? error.message : String(error))}</pre>`
      );
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  try {
    const app = createApp();

    const certPath = process.env.EBAY_LOCAL_TLS_CERT_PATH;
    const keyPath = process.env.EBAY_LOCAL_TLS_KEY_PATH;
    const useHttps = CONFIG.publicBaseUrl.startsWith('https://') && !!certPath && !!keyPath;

    const serverUrl = getServerBaseUrl();

    const onListening = (): void => {
      const protocol = useHttps ? 'HTTPS' : 'HTTP';
      console.log(`Server running at ${serverUrl} [${protocol}]`);
      console.log(`MCP (default):    ${serverUrl}/mcp`);
      console.log(`MCP (sandbox):    ${serverUrl}/sandbox/mcp`);
      console.log(`MCP (production): ${serverUrl}/production/mcp`);
      console.log(`OAuth (sandbox):  ${serverUrl}/sandbox/oauth/start`);
      console.log(`OAuth (prod):     ${serverUrl}/production/oauth/start`);
      console.log(`Validation Research:       ${serverUrl}/validation/run`);
      console.log(
        `Internal eBay Research session expiry check: ${serverUrl}/internal/ebay-research/check-session-expiry`
      );
    };

    let server: ReturnType<typeof app.listen>;

    if (useHttps) {
      let cert: Buffer;
      let key: Buffer;
      try {
        cert = readFileSync(certPath);
        key = readFileSync(keyPath);
      } catch (err) {
        console.error(
          `Fatal: could not read TLS cert/key files — ` +
            `EBAY_LOCAL_TLS_CERT_PATH=${certPath}, EBAY_LOCAL_TLS_KEY_PATH=${keyPath}\n`,
          err
        );
        throw err;
      }
      const httpsServer = createHttpsServer({ cert, key }, app);
      server = httpsServer.listen(CONFIG.port, CONFIG.host, onListening) as ReturnType<
        typeof app.listen
      >;
    } else {
      server = app.listen(CONFIG.port, CONFIG.host, onListening);
    }

    process.on('SIGINT', () => {
      server.close(() => {
        process.exitCode = 0;
        process.kill(process.pid, 'SIGTERM');
      });
    });
  } catch (error) {
    console.error('Fatal error starting server:', error);
    throw error;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (entryPath && modulePath === entryPath) {
  await main();
}
