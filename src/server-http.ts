import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { EbaySellerApi } from '@/api/index.js';
import {
  getConfiguredEnvironment,
  getHostedOauthScopes,
  getEbayConfig,
  getOAuthAuthorizationUrl,
  type EbayEnvironment,
} from '@/config/environment.js';
import { getToolDefinitions, executeTool } from '@/tools/index.js';
import { getVersion } from '@/utils/version.js';
import { serverLogger } from '@/utils/logger.js';
import { MultiUserAuthStore } from '@/auth/multi-user-store.js';

const CONFIG = {
  host: process.env.MCP_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? process.env.MCP_PORT ?? 3000),
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
 *
 * These clients drive the authorize flow directly and cannot always guarantee
 * that their /register request was persisted before /authorize is called.
 * We allow them to self-register on the fly so the flow doesn't hard-fail on
 * a missing client_id when the user's eBay app credentials are already in env.
 */
function isTrustedDesktopRedirectUri(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    // Desktop IDE callback schemes
    if (
      u.protocol === 'vscode:' ||
      u.protocol === 'cursor:' ||
      u.protocol === 'windsurf:' ||
      u.protocol === 'claude:'
    ) {
      return true;
    }
    // Localhost loopback (any port)
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

function createApp(): express.Application {
  const app = express();
  app.disable('x-powered-by');
  const currentFilename = fileURLToPath(import.meta.url);
  const currentDirname = dirname(currentFilename);
  const projectRoot = join(currentDirname, '..');

  app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'] }));
  app.use(express.json());
  // OAuth token endpoint sends application/x-www-form-urlencoded per RFC 6749
  app.use(express.urlencoded({ extended: false }));
  app.use(helmet({ xPoweredBy: false }));
  app.use('/icons', express.static(join(projectRoot, 'public', 'icons')));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      serverLogger.info(`${req.method} ${req.path} -> ${res.statusCode}`, {
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  const serverUrl = getServerBaseUrl();
  const iconBaseUrl = `${serverUrl}/icons`;

  app.get('/', (_req, res) => {
    res.json({
      name: 'ebay-mcp-remote-edition',
      version: getVersion(),
      mode: 'multi-user-hosted',
      oauth_start: `${serverUrl}/oauth/start?env=${getConfiguredEnvironment()}`,
      mcp_endpoint: `${serverUrl}/mcp`,
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), version: getVersion() });
  });

  // ── MCP OAuth 2.1 Authorization Server endpoints ─────────────────────────
  // Required so MCP clients (e.g. Cline) can discover and use this server's
  // built-in OAuth flow instead of hitting a 404 on /register.

  /** RFC 8414 – Authorization Server Metadata */
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/authorize`,
      token_endpoint: `${serverUrl}/token`,
      registration_endpoint: `${serverUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  /** RFC 7591 – Dynamic Client Registration */
  app.post('/register', async (req, res) => {
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
    const client = await authStore.registerClient(uris, clientName);
    serverLogger.info('[register] MCP client registered', {
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

  /**
   * RFC 6749 – Authorization Endpoint (PKCE required)
   * Validates the MCP client, stores context in state, then forward to eBay OAuth.
   */
  app.get('/authorize', requireOauthStartKey, async (req, res) => {
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
      const environment =
        q.env === 'sandbox' || q.env === 'production' ? q.env : getConfiguredEnvironment();

      serverLogger.info('[authorize] Request received', {
        clientId,
        redirectUri,
        responseType,
        hasPkce: !!codeChallenge,
        pkceMethod: codeChallengeMethod,
        environment,
        hasMcpState: !!mcpState,
      });

      if (responseType !== 'code') {
        serverLogger.warn('[authorize] Rejected: unsupported_response_type', { responseType });
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }
      if (!clientId) {
        serverLogger.warn('[authorize] Rejected: missing client_id');
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'client_id is required' });
        return;
      }

      // Look up the MCP client. If unknown, auto-register it for trusted desktop
      // redirect URIs (VS Code, Cursor, Windsurf, localhost) so that the flow
      // continues even when /register state was not persisted (e.g. memory backend)
      // or when the IDE drives /authorize directly without a prior /register call.
      let client = await authStore.getClient(clientId);
      if (!client) {
        if (redirectUri && isTrustedDesktopRedirectUri(redirectUri)) {
          serverLogger.info(
            '[authorize] Auto-registering trusted desktop MCP client (client_id not in store)',
            { clientId, redirectUri }
          );
          client = await authStore.registerClientWithId(clientId, [redirectUri]);
        } else {
          serverLogger.warn('[authorize] Rejected: unknown client_id (not a trusted desktop URI)', {
            clientId,
            redirectUri,
          });
          res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
          return;
        }
      }
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        serverLogger.warn('[authorize] Rejected: redirect_uri mismatch', {
          provided: redirectUri,
          registered: client.redirectUris,
        });
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri not registered for this client',
        });
        return;
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        serverLogger.warn('[authorize] Rejected: missing or invalid PKCE', {
          hasPkce: !!codeChallenge,
          method: codeChallengeMethod,
        });
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'PKCE with S256 code_challenge is required',
        });
        return;
      }

      const ebayConfig = getEbayConfig(environment);
      if (!ebayConfig.clientId || !ebayConfig.clientSecret || !ebayConfig.redirectUri) {
        serverLogger.error('[authorize] eBay app credentials missing in env', {
          hasClientId: !!ebayConfig.clientId,
          hasClientSecret: !!ebayConfig.clientSecret,
          hasRedirectUri: !!ebayConfig.redirectUri,
          environment,
        });
        res.status(500).json({
          error: 'server_error',
          error_description: `Missing eBay configuration for ${environment}`,
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
      serverLogger.info('[authorize] Redirecting to eBay OAuth', {
        state: stateRecord.state,
        environment,
      });
      res.redirect(oauthUrl);
    } catch (error) {
      serverLogger.error('[authorize] Unhandled error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        error: 'server_error',
        error_description: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * RFC 6749 – Token Endpoint
   * Exchanges a short-lived MCP authorization code (+ PKCE verifier) for a session token.
   */
  app.post('/token', async (req, res) => {
    serverLogger.info('[token] Request received', {
      contentType: req.headers['content-type'],
      hasBody: !!req.body,
    });

    // Body may be form-encoded (RFC 6749 §4.1.3) or JSON — both are parsed by middleware.
    // Guard against unparsed bodies (missing Content-Type header etc.)
    if (!req.body || typeof req.body !== 'object') {
      serverLogger.warn('[token] Rejected: missing or unparseable body');
      res.status(400).json({
        error: 'invalid_request',
        error_description:
          'Request body is missing or unparseable. Use application/x-www-form-urlencoded or application/json.',
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

    serverLogger.info('[token] Parsed fields', {
      grantType,
      hasCode: !!code,
      redirectUri,
      clientId,
      hasCodeVerifier: !!codeVerifier,
    });

    if (grantType !== 'authorization_code') {
      serverLogger.warn('[token] Rejected: unsupported_grant_type', { grantType });
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (!code) {
      serverLogger.warn('[token] Rejected: missing code');
      res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      return;
    }

    const authCode = await authStore.consumeAuthCode(code);
    if (!authCode) {
      serverLogger.warn('[token] Rejected: invalid or expired authorization code', {
        codePrefix: code.substring(0, 8),
      });
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      });
      return;
    }
    serverLogger.info('[token] Auth code found', {
      storedClientId: authCode.clientId,
      providedClientId: clientId,
      storedRedirectUri: authCode.redirectUri,
      providedRedirectUri: redirectUri,
    });
    if (authCode.clientId !== clientId) {
      serverLogger.warn('[token] Rejected: client_id mismatch', {
        stored: authCode.clientId,
        provided: clientId,
      });
      res.status(400).json({ error: 'invalid_client', error_description: 'client_id mismatch' });
      return;
    }
    if (authCode.redirectUri !== redirectUri) {
      serverLogger.warn('[token] Rejected: redirect_uri mismatch', {
        stored: authCode.redirectUri,
        provided: redirectUri,
      });
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    if (!codeVerifier) {
      serverLogger.warn('[token] Rejected: missing code_verifier');
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'code_verifier is required' });
      return;
    }

    // Verify PKCE S256: BASE64URL(SHA256(code_verifier)) must equal code_challenge
    const expectedChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      serverLogger.warn('[token] Rejected: PKCE verification failed', {
        expected: authCode.codeChallenge,
        computed: expectedChallenge,
      });
      res
        .status(400)
        .json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    const session = await authStore.createSession(authCode.userId, authCode.environment);
    serverLogger.info('[token] Session created, issuing access token', {
      userId: authCode.userId,
      environment: authCode.environment,
      sessionTokenPrefix: session.sessionToken.substring(0, 8),
    });
    res.json({
      access_token: session.sessionToken,
      token_type: 'bearer',
      scope: 'mcp',
    });
  });

  // ── End MCP OAuth 2.1 endpoints ───────────────────────────────────────────

  app.get('/oauth/start', requireOauthStartKey, async (req, res) => {
    try {
      const environment = ((typeof req.query.env === 'string' ? req.query.env : undefined) ??
        getConfiguredEnvironment()) as EbayEnvironment;
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

  app.get('/oauth/callback', async (req, res) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const envFromQuery = typeof req.query.env === 'string' ? req.query.env : undefined;
      const oauthError = typeof req.query.error === 'string' ? req.query.error : undefined;
      const errorDescription =
        typeof req.query.error_description === 'string' ? req.query.error_description : undefined;

      serverLogger.info('[oauth/callback] Received', {
        hasCode: !!code,
        hasState: !!state,
        oauthError,
      });

      if (oauthError) {
        serverLogger.warn('[oauth/callback] eBay returned OAuth error', {
          oauthError,
          errorDescription,
        });
        res
          .status(400)
          .send(`<h1>OAuth failed</h1><p>${htmlEscape(errorDescription ?? oauthError)}</p>`);
        return;
      }
      if (!code) {
        serverLogger.warn('[oauth/callback] Missing authorization code');
        res.status(400).send('<h1>Missing authorization code</h1>');
        return;
      }

      let environment: EbayEnvironment;
      let stateRecord: Awaited<ReturnType<typeof authStore.consumeOAuthState>> = null;
      if (state) {
        stateRecord = await authStore.consumeOAuthState(state);
        if (!stateRecord) {
          serverLogger.warn('[oauth/callback] OAuth state not found or expired', { state });
          res.status(400).send('<h1>Invalid or expired OAuth state</h1>');
          return;
        }
        environment = stateRecord.environment;
        serverLogger.info('[oauth/callback] State resolved', {
          environment,
          isMcpFlow: !!(stateRecord.mcpClientId && stateRecord.mcpRedirectUri),
          mcpClientId: stateRecord.mcpClientId,
          mcpRedirectUri: stateRecord.mcpRedirectUri,
        });
      } else {
        environment =
          envFromQuery === 'sandbox' || envFromQuery === 'production'
            ? envFromQuery
            : getConfiguredEnvironment();
        serverLogger.warn(
          'OAuth callback received without state; falling back to configured/query environment',
          { environment }
        );
      }

      const userId = randomUUID();
      const api = await createUserScopedApi(userId, environment);
      const oauthClient = api.getAuthClient().getOAuthClient();
      serverLogger.info('[oauth/callback] Exchanging code for eBay tokens', { userId });
      const tokenData = await oauthClient.exchangeCodeForToken(code);
      serverLogger.info('[oauth/callback] eBay token exchange successful', {
        userId,
        hasScope: !!tokenData.scope,
      });

      // ── MCP OAuth flow: redirect back to the registered MCP client ─────────
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
        serverLogger.info('[oauth/callback] MCP OAuth flow complete, redirecting to client', {
          clientId: stateRecord.mcpClientId,
          redirectUri: stateRecord.mcpRedirectUri,
          userId,
          authCodePrefix: authCodeRecord.code.substring(0, 8),
          finalRedirectUrl: redirectUrl.toString().substring(0, 120),
        });
        res.redirect(redirectUrl.toString());
        return;
      }
      // ── End MCP OAuth flow ─────────────────────────────────────────────────

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
    <script>
      async function copySessionToken() {
        const token = document.getElementById('session-token').innerText;
        const status = document.getElementById('copy-status');
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(token);
          } else {
            const temp = document.createElement('textarea');
            temp.value = token;
            temp.setAttribute('readonly', '');
            temp.style.position = 'absolute';
            temp.style.left = '-9999px';
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            document.body.removeChild(temp);
          }
          status.textContent = 'Copied!';
          setTimeout(() => { status.textContent = ''; }, 1800);
        } catch (err) {
          status.textContent = 'Copy failed — select manually';
          setTimeout(() => { status.textContent = ''; }, 2500);
        }
      }
    </script>
  </head>
  <body>
    <h1>eBay account connected</h1>
    <p>Your <strong>${htmlEscape(environment)}</strong> account has been connected successfully.</p>
    <div class="card">
      <p><strong>User ID:</strong> <code>${htmlEscape(userId)}</code></p>
      <p><strong>Paste this session token into Make or TypingMind as your API Key / Access token.</strong></p>
      <pre id="session-token">${htmlEscape(session.sessionToken)}</pre>
      <button class="copy-btn" onclick="copySessionToken()">Copy session token</button><span id="copy-status" class="copy-status"></span>
    </div>
    <div class="card">
      <p><strong>Authorization header format</strong></p>
      <pre>Authorization: Bearer ${htmlEscape(session.sessionToken)}</pre>
    </div>
    <p><strong>Scopes granted:</strong> ${htmlEscape(tokenData.scope ?? 'Not returned by eBay in token response')} — <a href="https://developer.ebay.com/my/keys" target="_blank" rel="noopener noreferrer">See full account scope list on the developer platform</a>.</p>
    <p class="muted">Keep this token private. If it is exposed, revoke it using the admin session endpoints and create a new one.</p>
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
  });

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

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const authenticateSession = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    const requestedEnv = ((typeof req.query.env === 'string' ? req.query.env : undefined) ??
      (typeof req.headers['x-ebay-env'] === 'string' ? req.headers['x-ebay-env'] : undefined) ??
      getConfiguredEnvironment()) as EbayEnvironment;

    const sendAuthorizationRequired = (
      reason: 'missing_session_token' | 'invalid_session_token'
    ): void => {
      const oauthUrl = new URL(`${getServerBaseUrl()}/oauth/start`);
      oauthUrl.searchParams.set('env', requestedEnv);
      if (CONFIG.oauthStartKey) {
        oauthUrl.searchParams.set('key', CONFIG.oauthStartKey);
      }

      if (req.method === 'GET') {
        res.redirect(oauthUrl.toString());
        return;
      }

      res.status(401).json({
        error: reason,
        authorization_required: true,
        environment: requestedEnv,
        authorization_url: oauthUrl.toString(),
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
      server.registerTool(
        toolDef.name,
        { description: toolDef.description, inputSchema: toolDef.inputSchema },
        async (args: Record<string, unknown>) => {
          try {
            const result = await executeTool(api, toolDef.name, args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
          serverLogger.info('New MCP session initialized', {
            sessionId: newSessionId,
            userId: userContext.userId,
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
    } else {
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

  app.post('/mcp', authenticateSession, mcpPostHandler);
  app.get('/mcp', authenticateSession, handleSessionRequest);
  app.delete('/mcp', authenticateSession, handleSessionRequest);

  return app;
}

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  try {
    const app = createApp();
    const server = app.listen(CONFIG.port, CONFIG.host, () => {
      const serverUrl = getServerBaseUrl();
      console.log(`Server running at ${serverUrl}`);
      console.log(`OAuth start: ${serverUrl}/oauth/start?env=production`);
      console.log(`OAuth start sandbox: ${serverUrl}/oauth/start?env=sandbox`);
      console.log(`MCP endpoint: ${serverUrl}/mcp`);
    });

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
