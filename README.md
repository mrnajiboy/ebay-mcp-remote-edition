# eBay MCP — Remote Edition

<div align="center">

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server providing AI assistants with comprehensive access to eBay's Sell APIs. **325+ tools** covering inventory management, order fulfillment, marketing campaigns, analytics, developer tools, and more.

**API Coverage:** 100% of eBay Sell APIs (270+ unique endpoints)

[![npm version](https://img.shields.io/npm/v/ebay-mcp-remote-edition.svg)](https://www.npmjs.com/package/ebay-mcp-remote-edition)
[![Socket Badge](https://socket.dev/api/badge/npm/package/ebay-mcp-remote-edition)](https://socket.dev/npm/package/ebay-mcp-remote-edition)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## Overview

This project extends [Yosef Hayim's eBay MCP](https://github.com/YosefHayim/ebay-mcp) with a full hosted, multi-user deployment mode while keeping the original local STDIO mode intact. The key additions are:

- **Hosted Streamable HTTP mode** — deploy to Render (or any Node.js host) and serve multiple users from one instance
- **MCP OAuth 2.1 authorization server** — full browser-based eBay login with automatic token management; Cline and other OAuth-aware clients connect with zero manual token pasting
- **Environment-scoped route trees** — `/sandbox/mcp` and `/production/mcp` hard-bind their eBay environment; no query param needed
- **Cloudflare KV / Upstash Redis** token and session storage for persistent multi-user auth
- **Admin session management** — inspect, revoke, or delete sessions via authenticated endpoints
- **TTL-aligned records** — every stored record (OAuth state, auth code, session, user token) carries an `expiresAt` timestamp and a matching KV/Redis TTL so storage and application expiry are always in sync

---

## ⚠️ Disclaimer

This is an open-source project provided "as is" without warranty of any kind. The authors accept **no responsibility or liability** for any damages arising from use of this software. This project is **not affiliated with, endorsed by, or sponsored by eBay Inc.** Test thoroughly in eBay's sandbox before using in production.

---

## Table of Contents

- [Choose a runtime mode](#choose-a-runtime-mode)
- [Prerequisites](#prerequisites)
- [Local mode setup](#local-mode-setup)
  - [Install](#install)
  - [Configure credentials](#configure-credentials)
  - [Run the setup wizard](#run-the-setup-wizard)
  - [Local client configuration](#local-client-configuration)
- [Hosted mode setup](#hosted-mode-setup)
  - [Environment variables](#hosted-environment-variables)
  - [Secret file](#secret-file)
  - [Deploy to Render](#deploy-to-render)
  - [OAuth flows](#oauth-flows)
  - [MCP endpoints](#mcp-endpoints)
  - [Remote client configuration](#remote-client-configuration)
- [Available tools](#available-tools)
- [Development](#development)
- [Testing & validation](#testing--validation)
- [Troubleshooting](#troubleshooting)
- [Resources](#resources)

---

## Choose a runtime mode

| Mode | Transport | Best for |
|------|-----------|----------|
| **Local STDIO** | stdin/stdout | Single-user local AI client (Claude Desktop, Cline, Cursor, etc.) |
| **Hosted HTTP** | Streamable HTTP | Multi-user server deployment; remote MCP clients |

Both modes use the same eBay tools. The local mode reads credentials from environment variables or a `.env` file. The hosted mode handles multi-user OAuth server-side and authenticates clients with session tokens.

---

## Prerequisites

**All modes:**
- Node.js ≥ 18.0.0
- [pnpm](https://pnpm.io/) (or npm — `npm install -g pnpm`)
- An [eBay Developer Account](https://developer.ebay.com/)

**Getting eBay credentials:**
1. Log in to the [eBay Developer Portal](https://developer.ebay.com/my/keys)
2. Create an application and copy your **App ID (Client ID)** and **Cert ID (Client Secret)**
3. Under **User Tokens → Add RuName**, register your OAuth callback URL and copy the generated **RuName** string

> **`EBAY_RUNAME` is the RuName string eBay generates, not the callback URL itself.** It looks like `YourApp-YourApp-SBX-abcdefghi`. The callback URL is set separately (see below).

### HTTPS callback URL (required by eBay)

eBay requires an HTTPS callback URL for OAuth. For local development, use [mkcert](https://github.com/FiloSottile/mkcert):

```bash
brew install mkcert nss
mkcert -install
mkcert ebay-local.test
echo "127.0.0.1  ebay-local.test" | sudo tee -a /etc/hosts
```

Register `https://ebay-local.test:3000/oauth/callback` in the eBay Developer Portal as your Accept URL. Then add to `.env`:

```bash
PUBLIC_BASE_URL=https://ebay-local.test:3000
EBAY_LOCAL_TLS_CERT_PATH=/path/to/ebay-local.test.pem
EBAY_LOCAL_TLS_KEY_PATH=/path/to/ebay-local.test-key.pem
```

For hosted deployments, register your server's public HTTPS URL instead (e.g. `https://your-server.com/oauth/callback`).

---

## Local mode setup

### Install

**Option A — npm global install (no build step):**

```bash
npm install -g ebay-mcp-remote-edition
```

**Option B — clone and build (for contributors or self-hosting):**

```bash
git clone https://github.com/mrnajiboy/ebay-mcp-remote-edition.git
cd ebay-mcp-remote-edition
pnpm install
pnpm run build
```

### Configure credentials

Create a `.env` file in the project root (see `.env.example`):

```bash
EBAY_CLIENT_ID=your_client_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_RUNAME=your_runame_string
EBAY_ENVIRONMENT=sandbox           # or production
EBAY_MARKETPLACE_ID=EBAY_US        # optional, defaults to EBAY_US
EBAY_CONTENT_LANGUAGE=en-US        # optional, defaults to en-US

# Populated by the setup wizard:
EBAY_USER_REFRESH_TOKEN=
```

**Authentication tiers:**

| Method | Rate limit | How |
|--------|-----------|-----|
| Client credentials (default) | 1,000 req/day | Just set `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` |
| User tokens (recommended) | 10,000–50,000 req/day | Run the setup wizard to complete OAuth and populate `EBAY_USER_REFRESH_TOKEN` |

### Run the setup wizard

The interactive wizard guides you through environment selection, credential entry, OAuth login, and MCP client configuration:

```bash
pnpm run setup
```

Options:
- `--quick` — skip optional steps
- `--diagnose` — run connectivity and token checks only

After completing OAuth, the wizard writes `EBAY_USER_REFRESH_TOKEN` to `.env` and optionally configures Claude Desktop automatically.

### Local client configuration

For direct STDIO usage, configure your MCP client to launch the server as a subprocess. All clients use the same JSON pattern:

**Using npm (no clone needed):**

```json
{
  "mcpServers": {
    "ebay": {
      "command": "npx",
      "args": ["-y", "ebay-mcp-remote-edition"],
      "env": {
        "EBAY_CLIENT_ID": "YOUR_CLIENT_ID",
        "EBAY_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "EBAY_ENVIRONMENT": "sandbox",
        "EBAY_RUNAME": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

**Using a local build:**

```json
{
  "mcpServers": {
    "ebay": {
      "command": "node",
      "args": ["/absolute/path/to/ebay-mcp-remote-edition/build/index.js"],
      "env": {
        "EBAY_CLIENT_ID": "YOUR_CLIENT_ID",
        "EBAY_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "EBAY_ENVIRONMENT": "sandbox",
        "EBAY_RUNAME": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

**Config file locations by client:**

| Client | Config file |
|--------|-------------|
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor (global) | `~/.cursor/mcp.json` |
| Cursor (project) | `.cursor/mcp.json` |

Zed, Windsurf, Continue.dev, Roo Code, and Amazon Q follow the same `mcpServers` JSON shape.

---

## Hosted mode setup

The hosted HTTP server exposes environment-scoped MCP and OAuth endpoints, handles eBay OAuth server-side, and issues session tokens to MCP clients.

### Hosted environment variables

```bash
# Server
PORT=3000
MCP_HOST=0.0.0.0
PUBLIC_BASE_URL=https://your-server.com

# eBay credentials (prefer secret file below instead of raw env)
EBAY_DEFAULT_ENVIRONMENT=production    # sandbox or production

# Persistent token/session storage backend (required for multi-user hosted mode)
EBAY_TOKEN_STORE_BACKEND=cloudflare-kv # cloudflare-kv | upstash-redis | memory

# Cloudflare KV (when EBAY_TOKEN_STORE_BACKEND=cloudflare-kv)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_KV_NAMESPACE_ID=
CLOUDFLARE_API_TOKEN=

# Upstash Redis (when EBAY_TOKEN_STORE_BACKEND=upstash-redis)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Security
ADMIN_API_KEY=              # required for admin session endpoints
OAUTH_START_KEY=            # optional; protects /oauth/start with a shared secret

# Session TTL (optional; default 30 days)
SESSION_TTL_SECONDS=2592000

# Logging
EBAY_LOG_LEVEL=info
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_CONTENT_LANGUAGE=en-US

# Path to secret file (see below)
EBAY_CONFIG_FILE=/etc/secrets/ebay-config.json
```

> Use `EBAY_TOKEN_STORE_BACKEND=memory` only for local development or tests. All OAuth state, session tokens, and user tokens are lost on restart.

### Secret file

Store eBay credentials in a mounted secret file rather than raw environment variables. On Render, create a **Secret File** named `ebay-config.json` mounted at `/etc/secrets/ebay-config.json`:

```json
{
  "production": {
    "clientId": "PROD_CLIENT_ID",
    "clientSecret": "PROD_CLIENT_SECRET",
    "redirectUri": "YOUR_PRODUCTION_RUNAME"
  },
  "sandbox": {
    "clientId": "SANDBOX_CLIENT_ID",
    "clientSecret": "SANDBOX_CLIENT_SECRET",
    "redirectUri": "YOUR_SANDBOX_RUNAME"
  }
}
```

### Deploy to Render

1. Connect your repo to Render as a **Web Service**
2. Set **Build command:**
   ```bash
   pnpm install && pnpm run build
   ```
3. Set **Start command:**
   ```bash
   pnpm run start:http
   ```
4. Add the environment variables listed above
5. Add the `ebay-config.json` secret file

The server starts on the port Render assigns via `$PORT` and logs the active KV backend on startup.

### OAuth flows

eBay requires a single registered callback URL per application. The hosted server registers `/oauth/callback` at the root and recovers the environment from the stored OAuth state record.

**Start an OAuth flow (browser):**

```
GET /sandbox/oauth/start         # always sandbox
GET /production/oauth/start      # always production
```

If `OAUTH_START_KEY` is set, include it as a query parameter or header:
```
GET /sandbox/oauth/start?key=YOUR_OAUTH_START_KEY
# or header:  X-OAuth-Start-Key: YOUR_OAUTH_START_KEY
```

After a successful login, the callback page displays your **session token**, **eBay access token**, and **eBay refresh token** with one-click copy buttons.

**Session token TTL schedule:**

| Record | `expiresAt` field | Backend TTL |
|--------|-------------------|-------------|
| OAuth state | 15 minutes | 15 minutes |
| MCP auth code | 10 minutes | 10 minutes |
| Session | 30 days (configurable) | Matches `SESSION_TTL_SECONDS` |
| User token record | eBay refresh token expiry (fallback: 18 months) | Matches token expiry |

### MCP endpoints

**Environment-scoped (recommended):**

```
POST/GET/DELETE /sandbox/mcp
POST/GET/DELETE /production/mcp
```

Each scoped path includes its own OAuth 2.1 discovery document:
```
GET /sandbox/.well-known/oauth-authorization-server
GET /production/.well-known/oauth-authorization-server
```

**Legacy auto-detect (backward-compatible):**
```
POST/GET/DELETE /mcp        # resolves environment from ?env= or EBAY_DEFAULT_ENVIRONMENT
```

**Authentication behavior:**
- `GET /mcp` (or scoped variant) without a valid Bearer token redirects the browser to the matching `oauth/start` URL
- `POST /mcp` without a valid Bearer token returns a structured `401` JSON with an `authorization_url` field
- All requests supply a session token via `Authorization: Bearer <session-token>`

**Other utility endpoints:**

```
GET  /health                           # Server health check (no auth required)
GET  /whoami                           # Session identity; requires Bearer token
GET  /admin/session/:sessionToken      # View session; requires X-Admin-API-Key
POST /admin/session/:sessionToken/revoke  # Revoke session
DELETE /admin/session/:sessionToken    # Delete session
```

`/whoami` response:
```json
{
  "userId": "...",
  "environment": "sandbox",
  "createdAt": "2026-03-23T08:00:00.000Z",
  "expiresAt": "2026-04-22T08:00:00.000Z",
  "lastUsedAt": "2026-03-23T09:30:00.000Z",
  "revokedAt": null
}
```

### Remote client configuration

Replace `https://your-server.com` with your actual `PUBLIC_BASE_URL`.

#### Cline (automatic OAuth — no manual token needed)

Cline supports MCP OAuth 2.1 discovery natively. It fetches the discovery document, registers itself, opens the eBay browser login, exchanges the auth code for a session token, and stores it — all automatically.

```json
{
  "mcpServers": {
    "ebay-sandbox": {
      "url": "https://your-server.com/sandbox/mcp"
    },
    "ebay-production": {
      "url": "https://your-server.com/production/mcp"
    }
  }
}
```

What Cline does automatically:
1. Fetches `/.well-known/oauth-authorization-server` for the scoped path
2. Registers at `POST /sandbox/register` (or `/production/register`)
3. Your browser opens `GET /sandbox/authorize`, which redirects to eBay login
4. After you grant access, eBay redirects to `/oauth/callback`, which issues an auth code
5. Cline exchanges the code at `POST /sandbox/token` for a session token and stores it
6. All subsequent `/sandbox/mcp` requests authenticate automatically

#### Claude Desktop and Cursor (Bearer token)

Claude Desktop and most other remote MCP clients require a pre-obtained session token. Complete the browser OAuth flow first:

1. Open `https://your-server.com/sandbox/oauth/start` (or `/production/oauth/start`) in a browser
2. Log in with your eBay account
3. Copy the session token from the confirmation page

Then configure your client:

```json
{
  "mcpServers": {
    "ebay-sandbox": {
      "url": "https://your-server.com/sandbox/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SESSION_TOKEN"
      }
    }
  }
}
```

#### Make / Zapier / TypingMind and similar platforms

1. Open `https://your-server.com/sandbox/oauth/start` in a browser and complete eBay login
2. Copy the session token from the confirmation page
3. Paste it as the **API Key / Bearer token** in the platform's MCP connector settings
4. Set the MCP endpoint URL to `https://your-server.com/sandbox/mcp`

---

## Available tools

325+ tools across all eBay Sell API categories:

- Account Management
- Inventory Management
- Order Fulfillment
- Marketing & Promotions
- Analytics & Reporting
- Communication (messages, feedback, notifications, negotiation)
- Metadata & Taxonomy
- Developer Tools (key management, analytics)
- Auth / Token helper tools

Full tool source: [`src/tools/definitions/`](src/tools/definitions/)

---

## Development

### Commands reference

| Command | Description |
|---------|-------------|
| `pnpm run build` | Compile TypeScript to JavaScript |
| `pnpm start` | Run local STDIO MCP server |
| `pnpm run start:http` | Run hosted HTTP MCP server |
| `pnpm run dev` | Local STDIO server with hot reload |
| `pnpm run dev:http` | Hosted HTTP server with hot reload |
| `pnpm test` | Run test suite |
| `pnpm run setup` | Interactive local setup wizard |
| `pnpm run sync` | Download latest eBay OpenAPI specs and regenerate types |
| `pnpm run diagnose` | Check configuration and connectivity |
| `pnpm run typecheck` | Run TypeScript type checking |
| `pnpm run check` | Typecheck + lint + format check |
| `pnpm run fix` | Auto-fix lint and format issues |

### `pnpm run sync`

Downloads the latest eBay OpenAPI specs, regenerates TypeScript types, and reports implemented vs missing endpoints. Run this when you want to pick up new eBay API surface:

```bash
pnpm run sync
pnpm run typecheck
pnpm run build
```

Review the diff, commit the generated changes you want to keep, and deploy.

### Local env management

For local development, standard runtime scripts automatically load `.env` via dotenvx. Hosted platforms should provide environment variables directly — the server detects hosted environments (e.g. `RENDER=true`) and skips local file loading.

```bash
pnpm run env:encrypt   # encrypt .env for safe sharing
pnpm run env:decrypt   # decrypt
```

### Logging

```bash
EBAY_LOG_LEVEL=debug             # error | warn | info | debug
EBAY_ENABLE_FILE_LOGGING=true    # write logs to files
```

---

## Testing & validation

```bash
# Build and type check
pnpm run build
pnpm run typecheck

# Run the test suite
pnpm test

# Check connectivity and token status
pnpm run diagnose

# Verify hosted server health
curl https://your-server.com/health

# Verify a session token
curl -H "Authorization: Bearer <session-token>" https://your-server.com/whoami

# Test MCP endpoint returns auth challenge when no token is provided
curl -X POST https://your-server.com/sandbox/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → should return 401 with authorization_url
```

---

## Troubleshooting

### Hosted MCP returns 406

Include the correct `Accept` header in your MCP client:
```
Accept: application/json, text/event-stream
```

### OAuth callback: "Invalid or expired OAuth state"

OAuth state records expire in 15 minutes. If you see this error, restart the browser OAuth flow.

### Token verification fails on existing refresh token

Refresh tokens expire after ~18 months or can be revoked by eBay (password changes, etc.). Run the setup wizard again to obtain a new one:
```bash
pnpm run setup
```

In hosted mode, start a new browser OAuth flow at `/sandbox/oauth/start` or `/production/oauth/start`.

### Session token no longer works in hosted mode

Check whether the session was revoked or expired:
```bash
curl -H "Authorization: Bearer <token>" https://your-server.com/whoami
```

Revoke exposed session tokens via the admin endpoint:
```bash
curl -X POST https://your-server.com/admin/session/<token>/revoke \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"
```

### Security checklist

- Do not commit `.env` or session tokens to version control
- Protect `/oauth/start` and `/admin/*` with `OAUTH_START_KEY` and `ADMIN_API_KEY`
- Keep `/oauth/callback` publicly reachable (eBay redirects to it after login)
- Keep `/health` reachable if Render uses it for health checks
- For production-grade isolation, optionally place `/`, `/oauth/start`, and `/admin/*` behind Cloudflare Access
- Rotate exposed eBay client secrets and update your secret file

---

## Resources

- [eBay Developer Portal](https://developer.ebay.com/)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [Auth Configuration Guide](docs/auth/CONFIGURATION.md)
- [OAuth Quick Reference](docs/auth/OAUTH_QUICK_REFERENCE.md)
- [API Status](docs/API_STATUS.md)
- [Changelog](CHANGELOG.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

---

## License

MIT — see [LICENSE](LICENSE)
