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

This project extends [Yosef Hayim's eBay MCP](https://github.com/YosefHayim/ebay-mcp) with hosted, multi-user deployment while preserving local STDIO mode. Key additions:

- **Hosted Streamable HTTP** — deploy anywhere, serve multiple users from one instance
- **MCP OAuth 2.1** — browser-based eBay login with automatic token management; OAuth-aware clients (Cline) connect without manual token pasting
- **Environment-scoped routes** — `/sandbox/mcp` and `/production/mcp` hard-bind their eBay environment
- **Cloudflare KV / Upstash Redis** — persistent multi-user token and session storage with TTL-aligned expiry
- **Admin session management** — inspect, revoke, or delete sessions via authenticated endpoints
- **eBay Research session persistence** — Playwright storage state to KV/Redis/filesystem via `EBAY_RESEARCH_SESSION_STORE`
- **QStash-triggered Telegram alerts** — expiry callbacks notify operators before research auth degrades

---

## ⚠️ Disclaimer

This is an open-source project provided "as is" without warranty of any kind. Not affiliated with, endorsed by, or sponsored by eBay Inc. Test thoroughly in sandbox before production.

---

## Table of Contents

- [Choose a runtime mode](#choose-a-runtime-mode)
- [Prerequisites](#prerequisites)
- [Local mode setup](#local-mode-setup)
- [Hosted mode setup](#hosted-mode-setup)
- [Tool discovery for agents](#tool-discovery-for-agents)
- [Available tools](#available-tools)
- [Development](#development)
- [Testing & validation](#testing--validation)
- [Troubleshooting](#troubleshooting)
- [Resources](#resources)

---

## Choose a runtime mode

| Mode | Command | Transport | Best for | Authorization model |
|------|---------|-----------|----------|---------------------|
| **Local STDIO** | `pnpm start` / `pnpm run dev` | stdin/stdout | Single-user local AI client (Claude Desktop, Cline, Cursor, etc.) | The local process reads eBay credentials and optional `EBAY_USER_REFRESH_TOKEN` from environment variables. |
| **Hosted HTTP** | `pnpm run start:http` / `pnpm run dev:http` | Streamable HTTP | Multi-user server deployment; remote MCP clients | Users authorize through browser OAuth. Requests can use normal session Bearer auth or opt into server-request auth with `X-Ebay-Server-Request: true`. |

Both modes use the same eBay tool registry. Local STDIO is best when one trusted local client owns the eBay credentials. Hosted HTTP runs an Express server with OAuth 2.1 discovery, environment-scoped route trees, server-side token/session storage, and admin-only operational endpoints.

---

## Prerequisites

**All modes:**
- Node.js ≥ 18.0.0
- [pnpm](https://pnpm.io/) (or npm — `npm install -g pnpm`)
- An [eBay Developer Account](https://developer.ebay.com/)

**Getting credentials:**
1. Log in to [eBay Developer Portal](https://developer.ebay.com/my/keys)
2. Create an application, copy **App ID (Client ID)** and **Cert ID (Client Secret)**
3. Under **User Tokens → Add RuName**, register your public HTTPS OAuth callback URL and copy the generated **RuName** string

> **`EBAY_RUNAME` and the public Redirect URL are distinct.** `EBAY_RUNAME` is the eBay-generated RuName string used as eBay's OAuth `redirect_uri` identifier (for example, `YourApp-YourApp-SB-abcdefghi`). The public Redirect URL is the real browser callback URL you register in eBay, such as `https://your-server.com/oauth/callback` or `https://ebay-local.test:3000/oauth/callback`; it is derived from `PUBLIC_BASE_URL` in this project. Do not use either value as a fallback for the other.

### HTTPS callback URL (required by eBay)

eBay requires HTTPS for OAuth callbacks. For local dev, use [mkcert](https://github.com/FiloSottile/mkcert):

```bash
brew install mkcert nss
mkcert -install
mkcert ebay-local.test
echo "127.0.0.1  ebay-local.test" | sudo tee -a /etc/hosts
```

Register `https://ebay-local.test:3000/oauth/callback` in the Developer Portal. Add to `.env`:

```bash
PUBLIC_BASE_URL=https://ebay-local.test:3000
EBAY_LOCAL_TLS_CERT_PATH=/path/to/ebay-local.test.pem
EBAY_LOCAL_TLS_KEY_PATH=/path/to/ebay-local.test-key.pem
```

#### Trust mkcert CA in Node.js

VS Code's extension host uses Node.js, which doesn't read macOS system keychain by default. Trust the cert:

```bash
# Current session (Dock/Spotlight-launched apps):
launchctl setenv NODE_EXTRA_CA_CERTS "$(mkcert -CAROOT)/rootCA.pem"

# Persist across reboots:
cat > ~/Library/LaunchAgents/com.local.mkcert-node-trust.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.mkcert-node-trust</string>
  <key>ProgramArguments</key>
  <array>
    <string>launchctl</string><string>setenv</string>
    <string>NODE_EXTRA_CA_CERTS</string>
    <string>/Users/YOUR_USERNAME/Library/Application Support/mkcert/rootCA.pem</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.local.mkcert-node-trust.plist

# Terminal-launched apps — add to ~/.zshrc:
echo 'export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"' >> ~/.zshrc
```

Then fully quit and reopen VS Code.

For hosted deployments, register your server's public HTTPS URL instead.

---

## Local mode setup

### Install

```bash
# Option A — global install (no build step):
pnpm install -g ebay-mcp-remote-edition

# Option B — clone and build (contributors):
git clone https://github.com/mrnajiboy/ebay-mcp-remote-edition.git
cd ebay-mcp-remote-edition
pnpm install && pnpm run build
```

### Configure credentials

Create `.env` (see `.env.example`):

```bash
EBAY_CLIENT_ID=your_client_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_RUNAME=your_runame_string       # eBay-generated RuName, not a URL
EBAY_REDIRECT_URI=                  # legacy env name; do not set to the public callback URL
EBAY_ENVIRONMENT=sandbox           # or production
EBAY_MARKETPLACE_ID=EBAY_US        # optional, defaults to EBAY_US
EBAY_CONTENT_LANGUAGE=en-US        # optional, defaults to en-US
EBAY_USER_REFRESH_TOKEN=           # populated by setup wizard
```

**Authentication tiers:**

| Method | Rate limit | How |
|--------|-----------|-----|
| Client credentials (default) | 1,000 req/day | Set `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` |
| User tokens (recommended) | 10,000–50,000 req/day | Run `pnpm run setup` to complete OAuth |

### Run the setup wizard

```bash
pnpm run setup          # interactive: env selection, credentials, OAuth, client config
pnpm run setup --quick  # skip optional steps
pnpm run setup --diagnose  # connectivity and token checks only
```

### Local client configuration

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
        "EBAY_REDIRECT_URI": "",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

**Config file locations:**

| Client | Config file |
|--------|-------------|
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |

Zed, Windsurf, Continue.dev, Roo Code, and Amazon Q follow the same `mcpServers` JSON shape.

---

## Hosted mode setup

### Environment variables

Hosted HTTP reads the same eBay credential variables as local STDIO plus the HTTP, storage, and security variables below. The start script is `pnpm run start:http`; development uses `pnpm run dev:http`.

```bash
# Required for hosted OAuth URLs and eBay callback registration
PUBLIC_BASE_URL=https://your-server.com

# Required eBay credentials unless EBAY_CONFIG_FILE provides them
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_RUNAME=
EBAY_REDIRECT_URI=                  # legacy env name; not the public callback URL
# Recommended when serving both environments from one host
EBAY_PRODUCTION_CLIENT_ID=
EBAY_PRODUCTION_CLIENT_SECRET=
EBAY_PRODUCTION_RUNAME=
EBAY_PRODUCTION_REDIRECT_URI=
EBAY_SANDBOX_CLIENT_ID=
EBAY_SANDBOX_CLIENT_SECRET=
EBAY_SANDBOX_RUNAME=
EBAY_SANDBOX_REDIRECT_URI=

# Required for hosted multi-user token/session persistence
EBAY_TOKEN_STORE_BACKEND=upstash-redis  # cloudflare-kv | upstash-redis | memory
UPSTASH_REDIS_REST_URL=                 # required when backend is upstash-redis
UPSTASH_REDIS_REST_TOKEN=               # required when backend is upstash-redis
CLOUDFLARE_ACCOUNT_ID=                  # required when backend is cloudflare-kv
CLOUDFLARE_KV_NAMESPACE_ID=             # required when backend is cloudflare-kv
CLOUDFLARE_API_TOKEN=                   # required when backend is cloudflare-kv

# Required for admin/validation endpoints and privileged MCP bypass
ADMIN_API_KEY=

# Optional HTTP/server behavior
PORT=3000                               # defaults to 3000; many hosts inject this
MCP_HOST=0.0.0.0                        # defaults to 0.0.0.0
EBAY_ENVIRONMENT=production             # root/legacy default selector
EBAY_DEFAULT_ENVIRONMENT=production     # fallback when EBAY_ENVIRONMENT is unset
SESSION_TTL_SECONDS=2592000             # default: 30 days
OAUTH_START_KEY=                        # optional gate for /oauth/start
EBAY_CONFIG_FILE=/etc/secrets/ebay-config.json
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_CONTENT_LANGUAGE=en-US
EBAY_LOG_LEVEL=info

# Optional validation runner identity
VALIDATION_RUNNER_USER_ID=
VALIDATION_RUNNER_USER_ID_SANDBOX=
VALIDATION_RUNNER_USER_ID_PRODUCTION=

# Optional validation/research providers and alerts
SOLD_ITEMS_API_URL=
SOLD_ITEMS_API_KEY=
PERPLEXITY_API_KEY=
TWITTER_BEARER_TOKEN=
YOUTUBE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
EBAY_RESEARCH_SESSION_ALERTS_ENABLED=true
EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL=
```

> `EBAY_TOKEN_STORE_BACKEND` defaults to Cloudflare KV when unset or unrecognized. Use `memory` only for tests or throwaway local development because hosted sessions and tokens are lost on restart.

### Secret file

Mount a JSON file with credentials (e.g., Render Secret File at `/etc/secrets/ebay-config.json`):

```json
{
  "production": {
    "clientId": "PROD_CLIENT_ID",
    "clientSecret": "PROD_CLIENT_SECRET",
    "redirectUri": "YOUR_PRODUCTION_RUNAME",
    "ruName": "YOUR_PRODUCTION_RUNAME"
  },
  "sandbox": {
    "clientId": "SANDBOX_CLIENT_ID",
    "clientSecret": "SANDBOX_CLIENT_SECRET",
    "redirectUri": "YOUR_SANDBOX_RUNAME",
    "ruName": "YOUR_SANDBOX_RUNAME"
  }
}
```

### Deploy to Render / Railway / Coolify

1. Connect your repo as a **Web Service**
2. **Build:** `pnpm install && pnpm run build`
3. **Start:** `pnpm run start:http`
4. Add environment variables + secret file

For Nixpacks-based platforms (Railway, Coolify): `nixpacks.toml` handles `pnpm`, build, Chromium install, and start automatically.

### OAuth flows

```
GET /sandbox/oauth/start      # sandbox browser login
GET /production/oauth/start   # production browser login
```

If `OAUTH_START_KEY` is set, start URLs require either `?key=YOUR_KEY` or the `X-OAuth-Start-Key: YOUR_KEY` header. The server also includes this key as `key` in generated `authorization_url` values for unauthenticated MCP requests.

After login, the callback page shows three hosted auth options with copy buttons:

| Hosted auth mode | How to select it | Best for |
|------------------|------------------|----------|
| **User/session mode** | Send `Authorization: Bearer <session-token>` and omit `X-Ebay-Server-Request` | Normal OAuth-aware MCP clients and user-scoped desktop clients. |
| **Server request mode — identity headers** | Send `X-Ebay-Server-Request: true`, `X-Ebay-Client-Id`, `X-Ebay-User-Id`, and optional `X-Ebay-Environment` | Server/client setups that need to handle both regular user requests and backend server requests without copying a session token. |
| **Server request mode — bearer-capable clients** | Send `X-Ebay-Server-Request: true` plus `Authorization: Bearer <mcp-server-issued-bearer-token>` | MCP clients or automation platforms that can store an authorization header but should not use the admin key. |

Switching between modes is per request, not a server-wide environment toggle. The same hosted MCP server can handle user/session requests and server requests concurrently; the client chooses server mode by adding `X-Ebay-Server-Request: true`.

**Session TTL schedule:**

| Record | TTL |
|--------|-----|
| OAuth state | 15 minutes |
| MCP auth code | 10 minutes |
| Session | 30 days (configurable) |
| User token | eBay refresh token expiry (fallback: 18 months) |

### MCP endpoints

**Environment-scoped (recommended):**
```
POST/GET/DELETE /sandbox/mcp
POST/GET/DELETE /production/mcp
```

Each includes OAuth 2.1 discovery: `GET /sandbox/.well-known/oauth-authorization-server`

**Legacy auto-detect:**
```
POST/GET/DELETE /mcp   # resolves from ?env= or EBAY_ENVIRONMENT/EBAY_DEFAULT_ENVIRONMENT
```

**Auth behavior:**
- `GET /mcp` without token → redirects to `oauth/start`
- `POST /mcp` without token → `401` JSON with `authorization_url`, `resource_metadata`, and a `WWW-Authenticate` Bearer challenge
- Normal user requests: `Authorization: Bearer <session-token>`
- Server requests with identity headers: `X-Ebay-Server-Request: true`, `X-Ebay-Client-Id: <client-id>`, `X-Ebay-User-Id: <user-id>`, `X-Ebay-Environment: sandbox|production`
- Server requests with bearer-capable clients: `X-Ebay-Server-Request: true` plus `Authorization: Bearer <mcp-server-issued-bearer-token>`
- Privileged admin bypass: `Authorization: Bearer <ADMIN_API_KEY>` when `ADMIN_API_KEY` is configured

The `X-Ebay-Server-Request` header is intentionally client-side and per-request. Leave it off for normal user/session OAuth calls. Add it when the MCP client is making a server-style request and should resolve the stored Redis/KV user token record by headers or by the MCP server-issued bearer lookup token. This bearer lookup token is generated by this MCP server on the OAuth callback page; it is **not** an eBay user access token, eBay refresh token, eBay client-credentials/app token, legacy hosted session token, or `ADMIN_API_KEY`.

#### Admin key bypass

`ADMIN_API_KEY` is used in two distinct ways:

| Use | Exact implementation | Scope |
|-----|----------------------|-------|
| Admin/validation HTTP routes | `X-Admin-API-Key: <ADMIN_API_KEY>` header | Required for `/admin/session/:sessionToken`, `/admin/session/:sessionToken/revoke`, `/admin/session/:sessionToken`, `/sandbox/validation/*`, `/production/validation/*`, and legacy `/validation/*`. |
| MCP authorization bypass | `Authorization: Bearer <ADMIN_API_KEY>` header | Lets privileged server-to-server/admin tooling call `/sandbox/mcp`, `/production/mcp`, or `/mcp` without a hosted user session lookup. The request runs with `userId` set to `admin` and the requested environment. |

The admin bypass does **not** use query parameters or request body fields. `ADMIN_API_KEY` must be configured on the server; if it is unset, admin HTTP routes return `500` and the MCP bypass is disabled.

Security caveats:
- Treat `ADMIN_API_KEY` as a privileged root credential for this MCP server.
- Generate a long, random value and store it only in your deployment secret manager.
- Use it only for server-to-server automation, operational checks, or admin tooling. Do not ship it to browsers, desktop clients, or regular users.
- OAuth browser authorization and hosted session tokens remain the normal path for user MCP access.

**Utility endpoints:**

```
GET  /health                               # health check (no auth)
GET  /whoami                               # session identity (Bearer token)
GET  /admin/session/:sessionToken          # view session (admin key)
POST /admin/session/:sessionToken/revoke   # revoke session
DELETE /admin/session/:sessionToken        # delete session
```

### Admin endpoints

All `/admin/*` routes accept authentication via either:
- Header: `X-Admin-API-Key: <ADMIN_API_KEY>`
- Query param: `?key=<ADMIN_API_KEY>` (useful for browser access)

```
GET  /admin/token-status              # OAuth + Playwright session health
POST /admin/oauth/start-for-validation # Start OAuth flow for validation runner
POST /admin/playwright-session        # Store Playwright storage state JSON
GET  /admin/playwright-capture        # Browser UI to capture eBay Research cookies
```

**`/admin/playwright-capture`** renders a self-service page for renewing the eBay Research Playwright session. Open it in a browser with the admin key as a query parameter:

```
https://your-server.com/admin/playwright-capture?key=YOUR_ADMIN_API_KEY
```

The page has two tabs:
1. **Auto-Capture** — loads eBay Research in an iframe (may be blocked by eBay's security policies)
2. **Manual Export** — provides step-by-step instructions to export cookies from Chrome DevTools, a bookmarklet for one-click cookie copying, and a text area to paste and submit the JSON

Submitted cookies are validated, stored in the configured session backend (Upstash Redis / Cloudflare KV / filesystem), and given a 5-month TTL.

### Validation endpoints

```
POST /sandbox/validation/run          # run validation pipeline
POST /production/validation/run

GET  /sandbox/validation/health       # check runner status
GET  /production/validation/health
```

Both require `X-Admin-API-Key: <ADMIN_API_KEY>`. The server impersonates the configured validation runner user from `VALIDATION_RUNNER_USER_ID` env vars.

See [Validation architecture](#validation-architecture) below for provider details.

### Remote client configuration

**Cline (automatic OAuth):**
```json
{
  "mcpServers": {
    "ebay-sandbox": { "url": "https://your-server.com/sandbox/mcp" },
    "ebay-production": { "url": "https://your-server.com/production/mcp" }
  }
}
```
Cline auto-discovers OAuth, opens browser login, exchanges auth code, and stores session token.

**Claude Desktop / Cursor (Bearer token):**
1. Open `https://your-server.com/sandbox/oauth/start` → complete eBay login → copy session token
2. Configure client:
```json
{
  "mcpServers": {
    "ebay-sandbox": {
      "url": "https://your-server.com/sandbox/mcp",
      "headers": { "Authorization": "Bearer YOUR_SESSION_TOKEN" }
    }
  }
}
```

**Server request mode (custom headers):**
1. Open `https://your-server.com/sandbox/oauth/start` or `https://your-server.com/production/oauth/start`
2. Complete eBay login
3. Copy the server request headers shown on the callback page
4. Configure the MCP client with those headers:
```json
{
  "mcpServers": {
    "ebay-production-server": {
      "url": "https://your-server.com/production/mcp",
      "headers": {
        "X-Ebay-Server-Request": "true",
        "X-Ebay-Client-Id": "YOUR_EBAY_CLIENT_ID",
        "X-Ebay-User-Id": "STORED_USER_ID_FROM_CALLBACK",
        "X-Ebay-Environment": "production"
      }
    }
  }
}
```

**Server request mode (bearer-capable clients):**
Use this when the MCP client can set `Authorization` but cannot easily send several custom identity headers:
```json
{
  "mcpServers": {
    "ebay-production-server": {
      "url": "https://your-server.com/production/mcp",
      "headers": {
        "X-Ebay-Server-Request": "true",
        "Authorization": "Bearer MCP_SERVER_ISSUED_BEARER_TOKEN_FROM_CALLBACK"
      }
    }
  }
}
```

**Make / Zapier / other platforms:**
1. Complete OAuth via browser at `/oauth/start`
2. If the platform supports multiple headers, use server request mode identity headers
3. If the platform only supports one auth header, use server request mode with the MCP server-issued bearer lookup token from the callback page
4. Set MCP URL to `https://your-server.com/sandbox/mcp`

---

## Tool discovery for agents

AI agents discover tools through the MCP protocol's `tools/list` call. The eBay MCP server exposes 325+ tools with a predictable naming and description structure optimized for agent searchability.

### Tool naming convention

All tools follow the pattern `ebay_<action>_<resource>`:

| Action | Meaning | Examples |
|--------|---------|----------|
| `get` | Read/fetch | `ebay_get_inventory_item`, `ebay_get_offers` |
| `create` | Create new | `ebay_create_offer`, `ebay_create_fulfillment_policy` |
| `update` | Modify existing | `ebay_update_offer`, `ebay_update_inventory_item` |
| `delete` | Remove | `ebay_delete_offer`, `ebay_delete_inventory_item` |
| `publish` | Activate | `ebay_publish_offer` |
| `withdraw` | Deactivate | `ebay_withdraw_offer` |
| `revise` | Modify listing | `ebay_revise_listing` |
| `bulk_` | Batch operations | `ebay_bulk_create_offer`, `ebay_bulk_update_price_quantity` |

### Tool descriptions are self-documenting

Each tool description includes:
- **What it does** — concise action description
- **OAuth scope required** — the minimum scope needed
- **Minimum scope URL** — for fine-grained permission setup

Example:
```
Get a specific inventory item by SKU.

Required OAuth Scope: sell.inventory.readonly or sell.inventory
Minimum Scope: https://api.ebay.com/oauth/api_scope/sell.inventory.readonly
```

### Tools organized by category

Tools are grouped into 13 category files in `src/tools/definitions/`:

| Category file | Tool prefix | Key operations |
|---------------|-------------|----------------|
| `inventory.ts` | `ebay_*inventory*`, `ebay_*offer*` | CRUD inventory items, offers, locations, bulk ops |
| `fulfillment.ts` | `ebay_*fulfillment*`, `ebay_*shipment*` | Shipments, fulfillment orders, shipping labels |
| `account.ts` | `ebay_*policy*` | Payment, return, fulfillment policies |
| `marketing.ts` | `ebay_*promotion*`, `ebay_*markdown*` | Promotions, markdown listings |
| `analytics.ts` | `ebay_*analytics*`, `ebay_*report*` | Analytics, reporting |
| `communication.ts` | `ebay_*message*`, `ebay_*feedback*` | Messages, feedback, notifications |
| `metadata.ts` | `ebay_*metadata*`, `ebay_*policies*` | Category policies, listing metadata |
| `taxonomy.ts` | `ebay_*category*` | Category tree, suggestions, item specifics |
| `browse.ts` | `ebay_*browse*`, `ebay_*product*` | Browse/search products |
| `trading.ts` | `ebay_*listing*`, `ebay_*create_listing*` | Trading API (XML/SOAP) operations |
| `developer.ts` | `ebay_*signing*`, `ebay_*vero*` | Key management, VERO reports |
| `other.ts` | Mixed | Misc/legacy endpoints |
| `token-management.ts` | `ebay_*oauth*`, `ebay_*token*` | OAuth helpers, token management |

### How agents find the right tool

1. **Search by name pattern** — `ebay_get_*` for reads, `ebay_create_*` for writes, `ebay_*offer*` for offers
2. **Search by description** — descriptions contain action keywords and resource names
3. **Search by OAuth scope** — `sell.inventory` for inventory, `sell.fulfillment` for shipping
4. **Use `tools/list`** — agents receive the full tool list with names and descriptions; filter programmatically

### Tool annotations

Tools carry MCP annotations that help agents understand behavior:

| Annotation | Meaning |
|-----------|---------|
| `readOnlyHint: true` | Safe to call; no side effects |
| `destructiveHint: true` | Irreversible; use caution |
| `idempotentHint: true` | Safe to retry |
| `openWorldHint: true` | May interact with external services |

---

## Available tools

325+ tools across all eBay Sell API categories. Full source: [`src/tools/definitions/`](src/tools/definitions/)

---

## Development

### Commands

| Command | Description |
|---------|-------------|
| `pnpm run build` | Compile TypeScript |
| `pnpm start` | Run local STDIO server |
| `pnpm run start:http` | Run hosted HTTP server |
| `pnpm run dev` | STDIO with hot reload |
| `pnpm run dev:http` | HTTP with hot reload |
| `pnpm test` | Run tests |
| `pnpm run setup` | Interactive setup wizard |
| `pnpm run sync` | Download eBay OpenAPI specs, regenerate types |
| `pnpm run diagnose` | Check config and connectivity |
| `pnpm run typecheck` | TypeScript type checking |
| `pnpm run check` | Typecheck + lint + format |
| `pnpm run fix` | Auto-fix lint and format |

### `pnpm run sync`

Download latest eBay OpenAPI specs and regenerate types:

```bash
pnpm run sync && pnpm run typecheck && pnpm run build
```

Review the diff, commit changes you want to keep, and deploy.

### Env management

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

## Validation architecture

The hosted backend includes a validation pipeline for item evaluation. Routes live in [`src/server-http.ts`](src/server-http.ts), logic in [`src/validation/`](src/validation).

**Module layout:**

| File | Purpose |
|------|---------|
| `types.ts` | Request/response contracts |
| `effective-context.ts` | Source-aware normalization (item vs event runs) |
| `run-validation.ts` | Orchestration entrypoint |
| `recommendation.ts` | Buy/track decision logic |
| `providers/ebay.ts` | Live browse-market snapshot |
| `providers/ebay-sold.ts` | Sold-data enrichment (temporary external provider) |
| `providers/terapeak.ts` | Terapeak / eBay Research metrics |
| `providers/ebay-research.ts` | Authenticated eBay Research fetcher |
| `providers/social.ts` | Twitter/X, YouTube, Reddit signals |
| `providers/chart.ts` | Chart-signal stub |
| `providers/research.ts` | Historical comeback research (Perplexity) |

**Flow:** Admin calls `/validation/run` → server resolves runner user → orchestrator queries all providers → merges signals → returns writes + decision + debug metadata.

**Merge precedence:** Terapeak > sold provider > browse provider for overlapping fields. Optional providers (social, research) only write when data resolves — never blank existing values.

**Known limitations:**
- Sold-data provider is temporary (external API via `SOLD_ITEMS_API_URL`)
- Social signals are supportive only — not authoritative buy triggers
- Chart provider is a stub
- eBay Research requires valid Playwright session

**eBay Research session management:**
- Bootstrap: `pnpm run research:bootstrap`
- Inspect: `pnpm run research:inspect-session`
- Browser check: `pnpm run research:check-browser`
- Session source precedence: KV → env vars → local files → fallback
- QStash alerts: 24h before, 6h before, and at expiry → Telegram

---

## Testing & validation

```bash
# Build and test
pnpm run build && pnpm run typecheck && pnpm test

# Connectivity check
pnpm run diagnose

# Hosted health
curl https://your-server.com/health

# Session check
curl -H "Authorization: Bearer <token>" https://your-server.com/whoami

# Validation runner health
curl https://your-server.com/sandbox/validation/health \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"

# Privileged MCP admin-key bypass check
curl https://your-server.com/sandbox/mcp \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Accept: application/json, text/event-stream"

# MCP auth challenge test
curl -X POST https://your-server.com/sandbox/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → 401 with authorization_url
```

---

## Troubleshooting

### Hosted MCP returns 406

Include `Accept: application/json, text/event-stream` header.

### OAuth callback: "Invalid or expired OAuth state"

OAuth state expires in 15 minutes. Restart the browser flow.

### Token verification fails on refresh token

Refresh tokens expire after ~18 months or can be revoked. Run `pnpm run setup` or start new browser OAuth at `/oauth/start`.

### Session token no longer works

```bash
# Check status:
curl -H "Authorization: Bearer <token>" https://your-server.com/whoami

# Revoke if exposed:
curl -X POST https://your-server.com/admin/session/<token>/revoke \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"
```

### Validation health is degraded

```bash
curl https://your-server.com/sandbox/validation/health \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"
```

Check: `VALIDATION_RUNNER_USER_ID` set, runner has stored tokens, tokens not expired, `SOLD_ITEMS_API_URL` configured.

### eBay Research shows `authState = missing`

```bash
pnpm run playwright:install
pnpm run build
pnpm run research:check-browser
pnpm run research:bootstrap
```

Expected after bootstrap: `authState = loaded`, `sessionStrategy = storage_state`, `sessionSource = kv`, `authValidationSucceeded = true`.

### Stale MCP sessions after deployment

After deploying new code, agents' MCP sessions may still point to old container code. **Agents must restart their MCP session** (`/reset` or reopen chat) to negotiate a fresh connection.

---

## Security checklist

- Do not commit `.env` or session tokens
- Protect `/oauth/start` with `OAUTH_START_KEY`, `/admin/*` and `/validation/*` with `ADMIN_API_KEY`
- Keep `ADMIN_API_KEY` long, random, server-side only, and separate from user session tokens; it also works as a privileged MCP Bearer-token bypass
- Keep `/oauth/callback` publicly reachable (eBay redirects here)
- Keep `/health` reachable for deployment health checks
- Rotate exposed eBay credentials and update secret file
- For production isolation, consider Cloudflare Access on `/`, `/oauth/start`, `/admin/*`

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
