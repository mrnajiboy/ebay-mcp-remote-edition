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

| Mode | Transport | Best for |
|------|-----------|----------|
| **Local STDIO** | stdin/stdout | Single-user local AI client (Claude Desktop, Cline, Cursor, etc.) |
| **Hosted HTTP** | Streamable HTTP | Multi-user server deployment; remote MCP clients |

Both modes use the same eBay tools. Local reads credentials from `.env`. Hosted handles multi-user OAuth server-side with session tokens.

---

## Prerequisites

**All modes:**
- Node.js ≥ 18.0.0
- [pnpm](https://pnpm.io/) (or npm — `npm install -g pnpm`)
- An [eBay Developer Account](https://developer.ebay.com/)

**Getting credentials:**
1. Log in to [eBay Developer Portal](https://developer.ebay.com/my/keys)
2. Create an application, copy **App ID (Client ID)** and **Cert ID (Client Secret)**
3. Under **User Tokens → Add RuName**, register your OAuth callback URL and copy the **RuName** string

> **`EBAY_RUNAME` is the RuName string eBay generates, not the callback URL.** It looks like `YourApp-YourApp-SBX-abcdefghi`.

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
EBAY_RUNAME=your_runame_string
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

```bash
# Server
PORT=3000
MCP_HOST=0.0.0.0
PUBLIC_BASE_URL=https://your-server.com
EBAY_DEFAULT_ENVIRONMENT=production

# Token storage backend (required for multi-user)
EBAY_TOKEN_STORE_BACKEND=upstash-redis  # cloudflare-kv | upstash-redis | memory

# Upstash Redis
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Cloudflare KV
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_KV_NAMESPACE_ID=
CLOUDFLARE_API_TOKEN=

# Research session alerts (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
EBAY_RESEARCH_SESSION_ALERTS_ENABLED=true
EBAY_RESEARCH_SESSION_ALERT_WINDOW_24H=true
EBAY_RESEARCH_SESSION_ALERT_WINDOW_6H=true
EBAY_RESEARCH_SESSION_ALERT_ON_EXPIRED=true
EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL=

# Validation runner identity
VALIDATION_RUNNER_USER_ID=
VALIDATION_RUNNER_USER_ID_SANDBOX=
VALIDATION_RUNNER_USER_ID_PRODUCTION=

# External providers (optional)
SOLD_ITEMS_API_URL=
SOLD_ITEMS_API_KEY=
PERPLEXITY_API_KEY=
TWITTER_BEARER_TOKEN=
YOUTUBE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=

# Security
ADMIN_API_KEY=              # required for admin endpoints
OAUTH_START_KEY=            # optional; protects /oauth/start

# Session TTL (default: 30 days)
SESSION_TTL_SECONDS=2592000

# Credentials (prefer secret file)
EBAY_CONFIG_FILE=/etc/secrets/ebay-config.json

# Logging
EBAY_LOG_LEVEL=info
```

> Use `EBAY_TOKEN_STORE_BACKEND=memory` only for local dev — all tokens are lost on restart.

### Secret file

Mount a JSON file with credentials (e.g., Render Secret File at `/etc/secrets/ebay-config.json`):

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

If `OAUTH_START_KEY` is set, append `?key=YOUR_KEY` or header `X-OAuth-Start-Key`.

After login, the callback page shows your **session token** with copy buttons.

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
POST/GET/DELETE /mcp   # resolves from ?env= or EBAY_DEFAULT_ENVIRONMENT
```

**Auth behavior:**
- `GET /mcp` without token → redirects to `oauth/start`
- `POST /mcp` without token → `401` JSON with `authorization_url`
- All requests: `Authorization: Bearer <session-token>`

**Utility endpoints:**

```
GET  /health                               # health check (no auth)
GET  /whoami                               # session identity (Bearer token)
GET  /admin/session/:sessionToken          # view session (admin key)
POST /admin/session/:sessionToken/revoke   # revoke session
DELETE /admin/session/:sessionToken        # delete session
```

### Validation endpoints

```
POST /sandbox/validation/run          # run validation pipeline
POST /production/validation/run

GET  /sandbox/validation/health       # check runner status
GET  /production/validation/health
```

Both require `X-Admin-API-Key`. The server impersonates the configured validation runner user from `VALIDATION_RUNNER_USER_ID` env vars.

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

**Make / Zapier / other platforms:**
1. Complete OAuth via browser at `/oauth/start`
2. Paste session token as API Key / Bearer token in connector settings
3. Set MCP URL to `https://your-server.com/sandbox/mcp`

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
- Protect `/oauth/start` with `OAUTH_START_KEY`, `/admin/*` with `ADMIN_API_KEY`
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
