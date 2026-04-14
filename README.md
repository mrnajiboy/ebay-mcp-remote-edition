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
- **Env-selected eBay Research session persistence** — the first-party research bootstrap/runtime can persist Playwright storage state to Cloudflare KV, Upstash KV, or explicit filesystem mode via `EBAY_RESEARCH_SESSION_STORE`
- **QStash-triggered Telegram alerts for eBay Research session expiry** — bootstrap can schedule version-aware expiry callbacks that notify operators before first-party research auth silently degrades
- **Alert-safe scheduling guardrails** — expiry callbacks are only scheduled when the callback URL is externally reachable and the research session store supports shared alert locks (`upstash-redis` or `filesystem`)

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
  - [Validation architecture](#validation-architecture)
  - [Validation endpoints and auth model](#validation-endpoints-and-auth-model)
  - [Diagnostics and health endpoints](#diagnostics-and-health-endpoints)
  - [Validation provider behavior and limitations](#validation-provider-behavior-and-limitations)
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

#### ⚠️ Trust the mkcert CA in Node.js (required for MCP clients like Cline)

VS Code's extension host (where Cline runs) uses Node.js for outbound HTTPS requests. Node.js does **not** automatically read macOS's system keychain, so the `ebay-local.test` certificate is not trusted by default. This causes the OAuth token exchange (`POST /sandbox/token`) to fail silently — the browser flow completes, the "Open in VS Code" page appears, but Cline never receives a session token.

**Fix — run these two commands once, then fully quit and reopen VS Code:**

```bash
# 1. Set for the current macOS session (affects all Dock/Spotlight-launched apps):
launchctl setenv NODE_EXTRA_CA_CERTS "$(mkcert -CAROOT)/rootCA.pem"

# 2. Create a LaunchAgent so it persists across reboots:
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

# 3. For terminal-launched VS Code — add to ~/.zshrc:
echo 'export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"' >> ~/.zshrc
```

> Replace `YOUR_USERNAME` with your actual macOS username in the plist, or use the full path printed by `mkcert -CAROOT`.

After running these commands and **fully quitting VS Code (Cmd+Q on macOS)** and reopening it, Cline's extension host will trust the `ebay-local.test` certificate and the MCP OAuth flow will complete successfully.

**Verify the fix works (without restarting VS Code):**
```bash
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node -e "
  require('https').get('https://ebay-local.test:3000/health', r => console.log('TLS OK — status:', r.statusCode)).on('error', e => console.error('TLS FAIL:', e.message));
"
# Expected: TLS OK — status: 200
```

For hosted deployments, register your server's public HTTPS URL instead (e.g. `https://your-server.com/oauth/callback`).

---

## Local mode setup

### Install

**Option A — pnpm global install (no build step):**

```bash
pnpm install -g ebay-mcp-remote-edition
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

# eBay Research session-expiry alerts (optional but recommended when using
# first-party research in hosted mode)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=1574052684
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
EBAY_RESEARCH_SESSION_ALERTS_ENABLED=true
EBAY_RESEARCH_SESSION_ALERT_WINDOW_24H=true
EBAY_RESEARCH_SESSION_ALERT_WINDOW_6H=true
EBAY_RESEARCH_SESSION_ALERT_ON_EXPIRED=true
EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL=

# Alert scheduling additionally requires:
# - PUBLIC_BASE_URL or EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL to be externally reachable
# - EBAY_RESEARCH_SESSION_STORE=upstash-redis or filesystem

# Security
ADMIN_API_KEY=              # required for admin session endpoints
OAUTH_START_KEY=            # optional; protects /oauth/start with a shared secret

# Validation runner identity (required for hosted /validation/* routes)
# Reuses a stored refresh-token-backed user in the existing multi-user auth store.
# Use the env-specific values when sandbox and production need different runner users.
VALIDATION_RUNNER_USER_ID=
VALIDATION_RUNNER_USER_ID_SANDBOX=
VALIDATION_RUNNER_USER_ID_PRODUCTION=

# Temporary sold-data enrichment provider for validation.
# This is an interim external abstraction and will be replaced by an internal
# sales-data implementation without changing the validation orchestration route.
SOLD_ITEMS_API_URL=
SOLD_ITEMS_API_KEY=

# Future orchestration-side historical research provider.
# Currently only used to enable the placeholder research contract.
PERPLEXITY_API_KEY=

# Optional phase-1 social-signal providers used by hosted validation.
# These signals are supportive only and should not be treated as authoritative
# automated buy triggers on their own.
TWITTER_BEARER_TOKEN=
YOUTUBE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=

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

### Deploy to Render / Railway / other Nixpacks hosts

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

For Nixpacks-based platforms such as Railway and Coolify:

- The repository now includes `nixpacks.toml` so the generated image uses `pnpm install --frozen-lockfile`, runs `pnpm run build`, installs Chromium for the Playwright-backed validation paths, and starts with `pnpm run start:http`.
- Runtime secrets should be configured in the platform dashboard as runtime environment variables or mounted secret files. Do not bake secrets into Docker build arguments or `ENV` layers.
- Keep `pnpm-lock.yaml` committed and in sync with `package.json`; Nixpacks installs with a frozen lockfile.

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
GET  /whoami                           # Session identity; requires Bearer session token
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

`/whoami` is the quickest hosted-session debugging check when an MCP client appears authenticated but requests still fail. It confirms which stored user session is active, which environment it is bound to, and whether the session has expired or been revoked.

### Validation architecture

The hosted backend now includes a deployment-oriented validation pipeline for non-MCP server-side execution. The route handlers live in [`src/server-http.ts`](src/server-http.ts), while the validation module lives under [`src/validation/`](src/validation).

Current module layout:

- [`src/validation/types.ts`](src/validation/types.ts) — request/response contracts for validation runs, decision payloads, debug payloads, and provider signal types
- [`src/validation/effective-context.ts`](src/validation/effective-context.ts) — source-aware normalization layer that converts raw request payloads into a first-class effective validation context for item and event runs
- [`src/validation/run-validation.ts`](src/validation/run-validation.ts) — orchestration entrypoint that validates input, queries providers, merges signals, and returns writes/decision/debug output
- [`src/validation/recommendation.ts`](src/validation/recommendation.ts) — recommendation and automation decision logic
- [`src/validation/providers/ebay.ts`](src/validation/providers/ebay.ts) — live eBay browse-market snapshot provider using the server's existing user-scoped eBay API client
- [`src/validation/providers/ebay-sold.ts`](src/validation/providers/ebay-sold.ts) — temporary sold-data provider backed by an external API via `SOLD_ITEMS_API_URL` and `SOLD_ITEMS_API_KEY`
- [`src/validation/providers/terapeak.ts`](src/validation/providers/terapeak.ts) — authenticated eBay Research provider orchestration for current-market and previous-POB metrics, including candidate scoring, fallback diagnostics, and sold-velocity bucketing
- [`src/validation/providers/ebay-research.ts`](src/validation/providers/ebay-research.ts) — low-level authenticated eBay Research fetcher with session-cookie sourcing, response parsing, and auth-aware cache invalidation
- [`src/validation/providers/query-utils.ts`](src/validation/providers/query-utils.ts) — shared multi-tier query candidate and fallback helpers used by browse and sold providers
- [`src/validation/providers/social.ts`](src/validation/providers/social.ts) — phase-1 social provider for recent Twitter/X activity, YouTube view-rate proxy data, and Reddit recent-post counts with graceful degradation
- [`src/validation/providers/chart.ts`](src/validation/providers/chart.ts) — chart-signal stub reserved for later implementation
- [`src/validation/providers/research.ts`](src/validation/providers/research.ts) — stable previous-comeback research contract provider for orchestration-side historical inference; currently a placeholder contract with optional future `PERPLEXITY_API_KEY` support

Current provider domains called by [`runValidation()`](src/validation/run-validation.ts:106):

- **browse/current-market** via [`src/validation/providers/ebay.ts`](src/validation/providers/ebay.ts)
- **sold enrichment** via [`src/validation/providers/ebay-sold.ts`](src/validation/providers/ebay-sold.ts)
- **Terapeak / eBay research contract** via [`src/validation/providers/terapeak.ts`](src/validation/providers/terapeak.ts)
- **social support signals** via [`src/validation/providers/social.ts`](src/validation/providers/social.ts)
- **chart support signals** via [`src/validation/providers/chart.ts`](src/validation/providers/chart.ts)
- **previous comeback research inference** via [`src/validation/providers/research.ts`](src/validation/providers/research.ts)

Architecturally, the validation stack is split into two practical classes of providers:

- **Server-side authenticated providers** — these run with the hosted backend's stored eBay user context and are the right place for authenticated marketplace retrieval. Today that means the live browse/current-market provider in [`src/validation/providers/ebay.ts`](src/validation/providers/ebay.ts), the sold enrichment layer in [`src/validation/providers/ebay-sold.ts`](src/validation/providers/ebay-sold.ts), and the Terapeak/eBay research contract in [`src/validation/providers/terapeak.ts`](src/validation/providers/terapeak.ts).
- **Orchestration-side research providers** — these run as supporting inference layers inside orchestration rather than as part of the user-scoped eBay API client surface. Today that means previous comeback resolution and external historical-research inference in [`src/validation/providers/research.ts`](src/validation/providers/research.ts), plus non-authoritative support providers such as [`src/validation/providers/social.ts`](src/validation/providers/social.ts) and [`src/validation/providers/chart.ts`](src/validation/providers/chart.ts).

Operationally, validation works like this:

1. An admin caller invokes an environment-scoped validation route.
2. The server resolves the environment (`sandbox` or `production`) from the mounted route tree.
3. The route looks up the configured validation runner user ID for that environment.
4. The server loads that user's stored refresh-token-backed credentials from the existing hosted auth store.
5. The validation orchestrator calls all six provider domains and gathers browse/current-market, sold enrichment, Terapeak/research contract data, social support signals, chart stub output, and previous-comeback research output.
6. Before provider execution, [`runValidation()`](src/validation/run-validation.ts) builds a normalized `effectiveContext` so downstream logic consumes a source-aware model (`item` or `event`) instead of relying on empty item placeholders.
7. [`runValidation()`](src/validation/run-validation.ts) deterministically merges the provider outputs into normalized field writes.
8. The response returns those writes, a conservative buy/track decision block, and provider debug metadata for downstream systems.

#### Effective validation context

Validation runs now normalize incoming request data into an internal effective context before provider query planning and recommendation logic execute.

- **Item-scope runs** normalize to an item-oriented context with the resolved artist, album/item phrase, location, and resolved search query.
- **Event-scope runs** normalize to an event-oriented context with `searchArtist`, `searchEvent`, `searchItem`, `searchLocation`, timing metadata, and a derived `effectiveSearchQuery` when no direct resolved query is present.
- Providers and recommendation logic consume that normalized context rather than reasoning about blank `item.recordId` or `item.name` fields.
- Debug output now exposes `effectiveSourceType`, `effectiveContextMode`, `effectiveSearchQuery`, `hasItem`, and `hasEvent` so operators can confirm whether an event run was normalized correctly.

The request schema also now accepts source-aware query-context fields for hosted validation runs:

- `resolvedSearchArtist`
- `resolvedSearchItem`
- `resolvedSearchEvent`
- `resolvedSearchLocation`
- `resolvedSearchQuery`

The validation contract is intentionally split between stable route orchestration and swappable providers. That is why the current sold-data source can be replaced later without changing downstream orchestration or the hosted route contract implemented in [`src/validation/run-validation.ts`](src/validation/run-validation.ts).

#### Deterministic merge precedence

The current merge order is fixed in [`runValidation()`](src/validation/run-validation.ts:106) so downstream systems can treat the writes as predictable rather than provider-order dependent:

- **Watchers / preorder count / shipping / competition** prefer Terapeak contract output when available, then fall back to the browse/current-market provider.
- **Market price** prefers Terapeak contract output, then the sold provider's median sold price, then the browse/current-market provider.
- **Sold day buckets** (`day1Sold` through `day5Sold`, plus `daysTracked`) prefer the sold provider, then authenticated eBay Research sold-row bucketing, then the browse/current-market provider.
- **Previous POB metrics** (`previousPobAvgPriceUsd`, `previousPobSellThroughPct`) are written from the Terapeak contract output when available.
- **Previous comeback first-week sales** (`previousComebackFirstWeekSales`) is written from the orchestration-side research provider when available.
- **Supportive social fields** are only written when a value is actually resolved, so the pipeline avoids blanking previously stored downstream data.

The validation signal contracts in [`TerapeakValidationSignals`](src/validation/types.ts:142) and [`PreviousComebackResearchSignals`](src/validation/types.ts:164) also back the new write fields in [`ValidationWrites`](src/validation/types.ts:176): `previousPobAvgPriceUsd`, `previousPobSellThroughPct`, and `previousComebackFirstWeekSales`.

### Validation endpoints and auth model

Use the environment-scoped hosted routes for validation:

```
POST /sandbox/validation/run
POST /production/validation/run

GET  /sandbox/validation/health
GET  /production/validation/health
```

Both routes require the admin key:

```
X-Admin-API-Key: YOUR_ADMIN_API_KEY
```

Auth model summary:

- Validation routes are **hosted HTTP backend routes**, not MCP tool endpoints.
- They do **not** use MCP client auth for execution.
- They reuse the existing stored refresh-token-backed hosted user architecture.
- The caller authenticates with `X-Admin-API-Key`, and the server then impersonates the configured validation runner user for the target environment.
- Validation runner identity comes from `VALIDATION_RUNNER_USER_ID`, `VALIDATION_RUNNER_USER_ID_SANDBOX`, or `VALIDATION_RUNNER_USER_ID_PRODUCTION`.
- The validation runner must already have stored hosted tokens in the configured token store backend.

#### `POST /validation/run`

Runs the validation pipeline for the target environment.

- Uses the configured validation runner user ID for that environment
- Requires that stored refresh-token-backed eBay credentials already exist for that user
- Returns either:
  - `status: "ok"` with `writes`, `decision`, and `debug`, or
  - `status: "error"` with `errorCode`, `message`, `retryable`, and `nextCheckAt`

The request/response contract is defined in [`src/validation/types.ts`](src/validation/types.ts), and the orchestration behavior is implemented in [`src/validation/run-validation.ts`](src/validation/run-validation.ts).

The `writes` payload is intentionally non-destructive for supportive and optional fields: if a social, authenticated eBay Research, or previous-comeback research provider cannot resolve data, the orchestration omits those optional writes instead of overwriting existing downstream values with empty placeholders.

#### `GET /validation/health`

Checks whether the validation runner is operational in the target environment.

This endpoint is intended for deployment diagnostics and returns:

- configured environment
- configured validation runner user ID
- whether stored tokens are present
- whether token refresh/authentication succeeded
- token status from the user-scoped eBay API client
- `authDebug` diagnostics including token endpoint resolution and credential presence
- provider availability summary

The diagnostics are especially useful after the OAuth token endpoint fix in [`getOAuthTokenBaseUrl()`](src/config/environment.ts:373) and the debug additions in [`getAuthDebugInfo()`](src/auth/oauth.ts:282). If the validation runner cannot refresh tokens, `/validation/health` shows the resolved token endpoint and any captured upstream response status/body excerpt.

### Diagnostics and health endpoints

Use these endpoints together when validating a hosted deployment:

```
GET /health
GET /whoami
GET /sandbox/validation/health
GET /production/validation/health
POST /internal/ebay-research/check-session-expiry
```

Recommended debugging flow:

1. Call `/health` to confirm the HTTP service is up.
2. Call `/whoami` with a Bearer hosted session token to confirm the active hosted user session, bound environment, expiry, and revocation status.
3. Call the matching env-scoped `/validation/health` route with `X-Admin-API-Key` to confirm the validation runner user is configured, stored tokens exist, and token refresh succeeds.
4. The internal `POST /internal/ebay-research/check-session-expiry` route is reserved for signed QStash callbacks and should not be used as an unauthenticated public endpoint.

`/whoami` is especially useful when an operator wants to verify which hosted session is currently active before registering or troubleshooting the validation runner user. Validation routes themselves still authenticate with the admin key and a stored hosted runner identity, not with MCP auth.

The validation health response is also the main place to verify the OAuth token-endpoint derivation fix from [`getOAuthTokenBaseUrl()`](src/config/environment.ts:373). If a refresh fails, the `authDebug` block exposes the resolved endpoint, credential-presence flags, and captured upstream response excerpts.

### Validation provider behavior and limitations

Current backend status:

- eBay live market snapshot support is implemented and wired into orchestration.
- Sold-data enrichment is implemented through a **temporary external provider** abstraction.
- Authenticated eBay Research is wired into orchestration for current-market and previous-POB retrieval, while previous-comeback research remains a separate placeholder contract.
- Social support signals are implemented in phase 1.
- Chart data remains a stub.
- Validation is currently an **admin-operated hosted backend workflow**, not an MCP tool surface.
- Event-scope validations are now handled as first-class normalized runs instead of as item-shaped requests with null item identity tolerated for compatibility.

Provider behavior:

- **Browse/eBay provider:** [`src/validation/providers/ebay.ts`](src/validation/providers/ebay.ts) uses the eBay Browse API plus shared query fallback logic from [`src/validation/providers/query-utils.ts`](src/validation/providers/query-utils.ts). It walks multiple query candidates, records the selected query and tier in debug output, and uses heuristic matching rather than a strict catalog identity join. Event-driven runs now build those fallback queries from normalized event context instead of raw item title assumptions.
- **Browse debug semantics:** validation debug now keeps browse candidate generation, selected query/tier, browse-specific sample size, and per-candidate result counts separate from sold-provider result counts so operators can tell whether the browse layer contributed a field, fell back to a weaker query, or returned no usable match.
- **Sold provider:** [`src/validation/providers/ebay-sold.ts`](src/validation/providers/ebay-sold.ts) uses a temporary external sold-data source configured by `SOLD_ITEMS_API_URL` and `SOLD_ITEMS_API_KEY`. It uses the same query-fallback strategy as the browse provider and returns sold-price ranges, sample sold items, and recent sold-velocity buckets when available.
- **Terapeak / eBay research provider:** [`src/validation/providers/terapeak.ts`](src/validation/providers/terapeak.ts) now evaluates authenticated eBay Research candidates for both current-market and previous-POB contexts, scores them against title alignment and subtype coverage, preserves per-candidate diagnostics in debug output, and derives sold-day buckets from sold-row timestamps when available.
- **Authenticated research session source:** [`src/validation/providers/ebay-research.ts`](src/validation/providers/ebay-research.ts) now prefers KV-backed Playwright storage state first, then environment-provided storage state / cookie fallbacks, then local storage-state/profile fallbacks for local development only. Parsed ACTIVE and SOLD tab responses are cached, automatically invalidated when the authenticated cookie fingerprint changes, and emit explicit auth-resolution debug fields including `sessionSource`, KV/env/filesystem attempt status, and fallback reasons.
- **Social provider:** [`src/validation/providers/social.ts`](src/validation/providers/social.ts) supports phase-1 Twitter/X recent activity, YouTube average-daily-views proxy data exposed through the `youtubeViews24hMillions` field, and Reddit recent post counts. These signals degrade gracefully on provider/API failure and are used as supportive indicators rather than authoritative demand truth.
- **Chart provider:** [`src/validation/providers/chart.ts`](src/validation/providers/chart.ts) is still a stub and does not currently contribute chart-based metrics.
- **Previous comeback research provider:** [`src/validation/providers/research.ts`](src/validation/providers/research.ts) now performs Perplexity-backed historical research when `PERPLEXITY_API_KEY` is configured. It attempts to resolve the prior comeback, normalize previous first-week sales when support exists, assign a `perplexityHistoricalContextScore`, generate concise `historicalContextNotes`, and emit debug diagnostics covering the research query, citations/snippets, resolved prior release, confidence, and score reasoning.

Recommendation behavior:

- [`src/validation/recommendation.ts`](src/validation/recommendation.ts) now accepts Terapeak and research inputs alongside browse, sold, social, and chart signals.
- Recommendation generation also consumes the normalized effective context so event runs can carry source-aware monitoring notes and avoid item-only assumptions when no usable item identity exists.
- Automatic tracking now pauses when the validation is still nominally in a watch state but the required source context or a usable derived query is missing.
- The decisioning remains intentionally conservative: Terapeak and research data can improve monitoring notes and confidence context, but the system still avoids aggressive automatic buy-state changes from partial or proxy signals alone.

Known limitations in the current implementation:

- The sold-data provider depends on external configuration via `SOLD_ITEMS_API_URL` and `SOLD_ITEMS_API_KEY`.
- If those sold-data variables are missing, validation still runs but sold enrichment degrades to an unavailable/error state rather than providing full historical-sales signals.
- The sold-data provider is temporary and intended to be replaced by an internal implementation later.
- Authenticated eBay Research requires a valid session source such as KV-backed Playwright storage state, `EBAY_RESEARCH_STORAGE_STATE_JSON`, `EBAY_RESEARCH_COOKIES_JSON`, a local Playwright storage-state file, or a local browser profile directory; without one, the provider degrades to diagnostic-only output with explicit structured auth-resolution debug.

#### eBay Research bootstrap and hosted runtime notes

- Install Chromium for hosted runtimes with [`package.json`](package.json) script `playwright:install` (`pnpm run playwright:install`).
- The Docker deployment path now provisions Chromium during image build in [`Dockerfile`](Dockerfile).
- Canonical production session source of truth is KV-backed Playwright storage-state JSON stored under `ebay_research_storage_state_json` with companion metadata in `ebay_research_storage_state_meta`, including `updatedAt`, `expiresAt`, `ttlSeconds`, `marketplace`, `sessionStore`, and `sessionVersion`.
- Bootstrap a signed-in eBay Research storage state into KV with [`src/scripts/bootstrap-ebay-research-session.ts`](src/scripts/bootstrap-ebay-research-session.ts) via the packaged/runtime-safe [`package.json`](package.json) script `research:bootstrap` (`pnpm run build && pnpm run research:bootstrap`).
- Inspect canonical eBay Research session persistence and fresh-client readback diagnostics with [`src/scripts/inspect-ebay-research-session.ts`](src/scripts/inspect-ebay-research-session.ts) via the packaged/runtime-safe [`package.json`](package.json) script `research:inspect-session` (`pnpm run build && pnpm run research:inspect-session`).
- Verify headless Chromium launchability with [`src/scripts/check-playwright.ts`](src/scripts/check-playwright.ts) via the packaged/runtime-safe [`package.json`](package.json) script `research:check-browser` (`pnpm run build && pnpm run research:check-browser`).
- Runtime precedence is: KV storage state → `EBAY_RESEARCH_STORAGE_STATE_JSON` → `EBAY_RESEARCH_COOKIES_JSON` → local storage-state file → local Playwright profile → explicit auth-missing fallback.
- Every candidate session source is validated against the first-party ACTIVE endpoint before the provider reports `authState = loaded`; failed validation is surfaced through debug fields including `kvStorageStateBytes`, `authValidationAttempted`, and `authValidationSucceeded`.
- Once a validated session is loaded, ACTIVE and SOLD endpoint fetches automatically become the preferred first-party research source while legacy active/sold fallbacks remain intact when auth is missing or invalid.
- Successful bootstrap also schedules signed QStash callbacks for 24 hours before expiry, 6 hours before expiry, and at expiry. Those callbacks target `POST /internal/ebay-research/check-session-expiry`, which verifies QStash signatures, suppresses stale reminders by `sessionVersion`, and sends Telegram alerts to `TELEGRAM_CHAT_ID`.
- Alert scheduling is intentionally skipped when the callback URL resolves to localhost/loopback or when `EBAY_RESEARCH_SESSION_STORE` uses a backend without shared lock support, because those configurations cannot safely deliver or deduplicate hosted reminders.
- Session refresh is manual by design for now: rerun `pnpm run build && pnpm run research:bootstrap` whenever eBay expires the stored session, then redeploy or restart the hosted service if your platform does not hot-reload env/KV-backed state.
- The previous-comeback research provider depends on grounded external research and therefore degrades to low-confidence notes with a zero historical score when `PERPLEXITY_API_KEY` is missing, the response cannot be normalized, or reliable evidence is not found.
- The browse provider still relies on heuristic query selection and fallback matching.
- The YouTube-backed `youtubeViews24hMillions` field is currently an **average daily views proxy**, not a true trailing 24-hour delta.
- Social signals are supportive/proxy data only and should not be presented as decisive automated buy logic.
- eBay-derived metrics are intentionally practical rather than exhaustive, but authenticated ACTIVE research rows now populate watcher-derived metrics whenever watcher counts are present in the first-party response.

### Roadmap note: provider maturation

- The current sold-data implementation is explicitly interim. It is isolated behind [`src/validation/providers/ebay-sold.ts`](src/validation/providers/ebay-sold.ts) so we can replace the external-provider-backed implementation with our own internal sales-data system later **without changing downstream validation orchestration or the hosted validation route contract**.
- The Terapeak/eBay research layer is intentionally isolated behind [`src/validation/providers/terapeak.ts`](src/validation/providers/terapeak.ts) so a future authenticated research integration can drop in without changing the route contract or downstream writes.
- The orchestration-side historical research layer is intentionally isolated behind [`src/validation/providers/research.ts`](src/validation/providers/research.ts) so future previous-comeback resolution or external inference providers can be added without rewriting the validation runner.

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

For local development, standard runtime scripts load `.env` via dotenvx only when a real local [`.env`](.env) file is present. Hosted platforms should provide environment variables directly — the server skips dotenvx for hosted/runtime environments (including Nixpacks-style deployments, which set [`DISABLE_DOTENVX`](nixpacks.toml:26)) and whenever no local [`.env`](.env) file exists.

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

# Verify validation runner health for sandbox
curl https://your-server.com/sandbox/validation/health \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"

# Run a hosted validation job
curl -X POST https://your-server.com/sandbox/validation/run \
  -H "Content-Type: application/json" \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY" \
  -d '{"validationId":"example-123","runType":"manual","cadence":"Daily","timestamp":"2026-03-31T00:00:00.000Z","item":{"recordId":"1","name":"Example Item","variation":[],"itemType":[],"releaseType":[],"releaseDate":null,"releasePeriod":[],"availability":[],"wholesalePrice":null,"supplierNames":[],"canonicalArtists":[],"relatedAlbums":[]},"validation":{"validationType":"default","buyDecision":"Hold","automationStatus":"Manual","autoCheckEnabled":false,"dDay":null,"artistTier":"unknown","initialBudget":null,"reserveBudget":null,"currentMetrics":{"avgWatchersPerListing":null,"preOrderListingsCount":null,"twitterTrending":false,"youtubeViews24hMillions":null,"redditPostsCount7d":null,"marketPriceUsd":null,"avgShippingCostUsd":null,"competitionLevel":null,"marketPriceTrend":"Stable","day1Sold":null,"day2Sold":null,"day3Sold":null,"day4Sold":null,"day5Sold":null,"daysTracked":null}}}'

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

### Validation health is degraded

Start with the environment-scoped health endpoint:

```bash
curl https://your-server.com/sandbox/validation/health \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"
```

Common causes:

- `VALIDATION_RUNNER_USER_ID` or the env-specific override is missing
- the validation runner user has no stored refresh-token-backed credentials in the hosted token store
- the refresh token is expired or revoked upstream
- `SOLD_ITEMS_API_URL` or `SOLD_ITEMS_API_KEY` is missing, causing sold enrichment to degrade
- one or more social-provider credentials are absent, which causes the related supportive signal to degrade gracefully instead of failing the entire run

### eBay Research debug shows `authState = missing` or `sessionStrategy = none`

This means the first-party research provider could not load a validated authenticated session and validation is intentionally falling back to browse and/or the temporary sold provider.

Run this checklist:

```bash
pnpm run playwright:install
pnpm run build
pnpm run research:check-browser
pnpm run research:bootstrap
```

Expected post-bootstrap debug characteristics from [`src/validation/providers/ebay-research.ts`](src/validation/providers/ebay-research.ts):

- `authState = loaded`
- `sessionStrategy = storage_state`
- `sessionSource = kv`
- `kvLoadAttempted = true`
- `kvLoadSucceeded = true`
- `authValidationAttempted = true`
- `authValidationSucceeded = true`

If the provider still reports `missing`, verify that your hosted deployment can reach the configured KV backend, that Chromium is available in the runtime image, and that the stored eBay session has not expired. Refresh the session by rerunning `pnpm run research:bootstrap`.

If `authDebug.tokenEndpoint` or the captured upstream response looks wrong, verify the environment-specific OAuth configuration and token-base resolution.

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
