# eBay MCP (Remote Edition)
<div align="center">

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server providing AI assistants with comprehensive access to eBay's Sell APIs. Includes **325+ tools** for inventory management, order fulfillment, marketing campaigns, analytics, developer tools, and more.

**API Coverage:** 100% (270+ unique eBay API endpoints)

[![npm version](https://img.shields.io/npm/v/ebay-mcp-remote-edition.svg)](https://www.npmjs.com/package/ebay-mcp-remote-edition)
[![Socket Badge](https://socket.dev/api/badge/npm/package/ebay-mcp-remote-edition)](https://socket.dev/npm/package/ebay-mcp-remote-edition)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

----

## Fork differences

This fork of [Yosef Hayim's eBay MCP](https://github.com/YosefHayim/ebay-mcp) preserves the original local/STDIO workflow up to v1.7.5, while expanding and focusing on adding hosted multi-user support for both ephemeral and persistant remote server instances. For all intents and purposes, any changes made to the original project from that version on is completely independent of any changes made here, and may be considered a wholly separate project.

### Added in this fork

- Hosted Streamable HTTP MCP deployment mode for remote server deployment
- Multi-user server-side eBay OAuth for both production and sandbox
- Cloudflare KV / Upstash Redis-backed storage for:
  - OAuth state
  - user token records
  - session records
- Session-token based MCP auth:
  - `Authorization: Bearer <session-token>`
- Render Secret File support for environment-specific credentials
- Admin session inspection/revocation endpoints
- `GET /whoami` endpoint for session-bound identity lookup
- Optional `OAUTH_START_KEY` protection for `/oauth/start`
- **MCP OAuth 2.1 authorization server** — Cline and other MCP clients that support OAuth discovery (`/.well-known/oauth-authorization-server`, `POST /register`, `GET /authorize`, `POST /token`) can authenticate fully automatically via browser eBay OAuth with no manual token pasting

---

## One-Click AI Setup

> **Let your AI assistant set this up for you!** Copy the prompt below and paste it into Claude, ChatGPT, or any AI assistant with MCP support.

<details>
<summary><strong>Click to copy the AI setup prompt</strong></summary>

```text
I want to set up the eBay MCP Server for my AI assistant. Please help me:

1. Install the eBay MCP server:
git clone https://github.com/mrnajiboy/ebay-mcp-remote-edition.git
cd ebay-mcp-remote-edition
pnpm install
pnpm run build

2. I need to configure it for [Claude Desktop / Cursor / Cline / Zed / Continue.dev / Windsurf / Claude Code CLI / Amazon Q] (choose one)

3. My eBay credentials are:
   - Client ID: [YOUR_CLIENT_ID]
   - Client Secret: [YOUR_CLIENT_SECRET]
   - Environment: [sandbox / production]
   - Redirect URI (RuName): [YOUR_REDIRECT_URI]

Please:
- Create the appropriate config file for my MCP client
- Set up the environment variables
- Help me complete the OAuth flow to get a refresh token for higher rate limits
- Test that the connection works

If I don't have eBay credentials yet, guide me through creating a developer account at https://developer.ebay.com/
```

</details>

---

## ⚠️ Disclaimer

**IMPORTANT: Please read this disclaimer carefully before using this software.**

This is an **open-source project** provided "as is" without warranty of any kind, either express or implied. By using this software, you acknowledge and agree to the following:

- **No Liability:** The authors, contributors, and maintainers of this project accept **NO responsibility or liability** for any damages, losses, or issues that may arise from using this software.
- **eBay API Usage:** This project is an unofficial third-party implementation and is **NOT affiliated with, endorsed by, or sponsored by eBay Inc.**
- **Use at Your Own Risk:** Test thoroughly in eBay's sandbox before production use.
- **Security:** You are responsible for securing API credentials, session tokens, and hosted endpoints.

For official eBay API support, please refer to the [eBay Developer Program](https://developer.ebay.com/).

---

## Table of Contents

- [Fork additions in this deployment-focused version](#fork-additions-in-this-deployment-focused-version)
- [⚠️ Disclaimer](#️-disclaimer)
- [Features](#features)
- [Quick Start](#quick-start)
  - [Local MCP Client Configuration](#local-mcp-client-configuration)
- [Hosted Render Deployment](#hosted-render-deployment)
  - [Hosted MCP Client Configuration](#hosted-mcp-client-configuration)
- [Configuration](#configuration)
- [Available Tools](#available-tools)
- [Development](#development)
- [Logging](#logging)
- [Troubleshooting](#troubleshooting)
- [Resources](#resources)
- [License](#license)

## Features

- **325+ eBay API Tools** - 100% coverage of eBay Sell APIs across inventory, orders, marketing, analytics, developer tools, and more
- **9 AI Clients Supported** - Auto-configuration for Claude Desktop, Cursor, Zed, Cline, Continue.dev, Windsurf, Roo Code, Claude Code CLI, and Amazon Q
- **OAuth 2.0 Support** - Full user token management with automatic refresh
- **Type Safety** - Built with TypeScript, Zod validation, and OpenAPI-generated types
- **MCP Integration** - STDIO transport for local integration and HTTP transport for hosted deployment
- **Smart Authentication** - Automatic fallback from user tokens to client credentials where applicable
- **Hosted Multi-User Mode** - Server-side OAuth + session-token auth for hosted MCP access
- **Well Tested** - Comprehensive typecheck/build/deploy validation
- **Interactive Setup Wizard** - Run `pnpm run setup` for guided local configuration
- **Developer Analytics** - Rate limit monitoring and signing key management

## Quick Start

### 1. Get eBay Credentials

1. Create a free [eBay Developer Account](https://developer.ebay.com/)
2. Generate application keys in the [Developer Portal](https://developer.ebay.com/my/keys)
3. Save your **Client ID** and **Client Secret**
4. Configure a **RuName** (Redirect URL Name) for each environment you plan to use

> **Local HTTPS callback URL (required by eBay)**
>
> eBay requires an **HTTPS** callback URL. For local development, use [mkcert](https://github.com/FiloSottile/mkcert) to create a locally-trusted certificate so your dev machine can serve HTTPS.
>
> **One-time mkcert setup (macOS):**
> ```bash
> brew install mkcert nss          # nss adds Firefox trust support
> mkcert -install                  # installs local CA into system trust store
> mkcert ebay-local.test           # creates ebay-local.test.pem + ebay-local.test-key.pem
> echo "127.0.0.1  ebay-local.test" | sudo tee -a /etc/hosts
> ```
>
> In the eBay Developer Portal, register **`https://ebay-local.test:3000/oauth/callback`** as the callback URL under **User Tokens → Add RuName**. eBay will generate a RuName string (e.g. `YourApp-YourApp-SBX-abcdefg`). Copy that RuName into `EBAY_RUNAME` (or `EBAY_SANDBOX_RUNAME` / `EBAY_PRODUCTION_RUNAME`).
>
> Then add to your `.env`:
> ```
> PUBLIC_BASE_URL=https://ebay-local.test:3000
> EBAY_LOCAL_TLS_CERT_PATH=/path/to/ebay-local.test.pem
> EBAY_LOCAL_TLS_KEY_PATH=/path/to/ebay-local.test-key.pem
> ```
>
> The server automatically starts an HTTPS callback listener when `PUBLIC_BASE_URL` begins with `https://`.
>
> **Note:** `EBAY_RUNAME` is an eBay-generated string (the RuName), **not** the callback URL itself. The callback URL is set via `PUBLIC_BASE_URL`. If your eBay app was previously configured only with a hosted callback URL, you will need to add the local URL as an additional RuName in the portal — eBay currently only allows one OAuth-enabled RuName per app at a time.

### 2. Install

**Option A — npm (easiest, no build step required):**

```bash
npm install -g ebay-mcp-remote-edition
# or
pnpm add -g ebay-mcp-remote-edition
```

Then run the setup wizard:

```bash
ebay-mcp-remote-edition --setup
```

**Option B — clone and build (for contributors or if you want to self-host the HTTP server):**

```bash
git clone https://github.com/mrnajiboy/ebay-mcp-remote-edition.git
cd ebay-mcp-remote-edition
pnpm install
pnpm run build
```

### Environment management with dotenvx

`dotenvx` is for local env workflows only.

Hosted/server platforms should provide environment variables directly.
For local development, the standard runtime scripts automatically load `.env`
through dotenvx unless a hosted environment is detected.

Common commands:

```bash
pnpm run env:encrypt
pnpm run env:decrypt
pnpm run env:run -- pnpm run dev:http
```

This lets you keep a local `.env` for development while also supporting
encrypted env files for sharing or deployment workflows.

The built-in runtime scripts now behave like this:

- local machine → load `.env` via dotenvx automatically
- hosted platform (for example `RENDER=true`) → use platform-provided env vars directly

### 3. Run Local Setup Wizard

For local/STDIO usage after cloning:

```bash
pnpm run setup
```

### 4. Hosted Mode

For hosted Render usage, see the next section.

---

## Local MCP Client Configuration

Two ways to configure your MCP client for local (STDIO) usage:

- **Option A — `npx` (no clone needed):** Use `npx -y ebay-mcp-remote-edition` as the command. npm downloads and runs the latest published version automatically.
- **Option B — local build:** Clone the repo, run `pnpm run build` and `pnpm run setup`, then point at `/absolute/path/to/ebay-mcp-remote-edition/build/index.js`.

The configs below show both. Supply your eBay credentials either as `env` fields in the config or via a `.env` file in the working directory.

> **Getting your credentials:** Run `pnpm run setup` in the cloned repo — it completes the OAuth flow and writes `EBAY_USER_REFRESH_TOKEN` to `.env`.

> **`EBAY_RUNAME` is a RuName string, not a URL.** It looks like `YourApp-YourApp-SBX-abcdefg`. To obtain one, register your HTTPS callback URL in the [eBay Developer Portal](https://developer.ebay.com/my/auth) under **User Tokens → Add RuName**, then copy the generated string. See [Step 1](#1-get-ebay-credentials) for the full setup guide including mkcert local HTTPS. `EBAY_REDIRECT_URI` is still accepted as a legacy alias for `EBAY_RUNAME`.

### Cline

Config file location:  
`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

**Using npx (no clone needed):**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

**Using local build:**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

### Claude Desktop

Config file location:  
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**Using npx:**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

**Using local build:**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

### Cursor

Global config: `~/.cursor/mcp.json`  
Project config: `.cursor/mcp.json` (in your project root)

**Using npx:**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

**Using local build:**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

### Other STDIO clients (Zed, Windsurf, Continue.dev, Roo Code, Amazon Q)

All STDIO-based clients use the same pattern. Use `npx -y ebay-mcp-remote-edition` for zero-install, or point `command` at `node` with `build/index.js` for a local build.

**Using npx:**

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
        "EBAY_REDIRECT_URI": "YOUR_RUNAME",
        "EBAY_USER_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

---

## Hosted Render Deployment

### Build command

```bash
pnpm install && pnpm run build
```

### Start command

```bash
pnpm run start:http
```

On hosted platforms, this uses the platform env directly and does not try to load local `.env` files.

### Recommended Render environment variables

```bash
PORT=
MCP_HOST=0.0.0.0
NODE_VERSION=
PUBLIC_BASE_URL=https://your-server.com
EBAY_CONFIG_FILE=/etc/secrets/ebay-config.json
EBAY_DEFAULT_ENVIRONMENT=sandbox|production
EBAY_TOKEN_STORE_BACKEND=cloudflare-kv|upstash-redis
CLOUDFLARE_ACCOUNT_ID=ID
CLOUDFLARE_KV_NAMESPACE_ID=ID
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=your-upstash-rest-token
ADMIN_API_KEY=your-admin-api-key
OAUTH_START_KEY=optional-shared-secret-for-oauth-start
EBAY_MARKETPLACE_ID=EBAY_COUNTRY
EBAY_CONTENT_LANGUAGE=lang-COUNTRY
EBAY_LOG_LEVEL=info
```

### Render secret file

Filename:

```text
ebay-config.json
```

Example contents:

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

Render mounts it at:

```text
/etc/secrets/ebay-config.json
```

### OAuth flows

Start production OAuth:

```text
/oauth/start?env=production
```

Start sandbox OAuth:

```text
/oauth/start?env=sandbox
```

If `OAUTH_START_KEY` is configured, include either:

```text
/oauth/start?env=production&key=YOUR_OAUTH_START_KEY
```

or send:

```text
X-OAuth-Start-Key: YOUR_OAUTH_START_KEY
```

### Hosted session token usage

After successful callback, the app issues a session token and stores it in the configured persistent backend (Cloudflare KV or Upstash Redis), then displays it in a copy-friendly callback page.

Use it in your MCP client:

```text
Authorization: Bearer <session-token>
```

For Make/Zapier/TypingMind anywhere where Remote MCP is accepted, the practical supported flow is:

1. complete browser OAuth via the hosted server
2. copy the returned session token from the callback page
3. paste it into the platform's API Key / Access token field

Normal MCP usage should not open a browser window once a valid hosted session token already exists in the configured persistent store.

### Admin endpoints

Require:

```text
X-Admin-API-Key: <ADMIN_API_KEY>
```

Endpoints:

- `GET /admin/session/:sessionToken`
- `POST /admin/session/:sessionToken/revoke`
- `DELETE /admin/session/:sessionToken`

### Session introspection

```text
GET /whoami
Authorization: Bearer <session-token>
```

### MCP endpoint

```text
POST /mcp
GET /mcp
DELETE /mcp
```

#### Initial auth behavior

- `GET /mcp` without a valid Bearer token redirects into browser OAuth
- default environment is production
- sandbox can be requested with `?env=sandbox`
- `POST /mcp` without a valid Bearer token returns an auth-required JSON response

This means browser-driven onboarding works cleanly, while protocol clients can still receive a structured auth response.

### Privacy recommendations

If you want the service URL to be less exposed:

- protect `/oauth/start` with `OAUTH_START_KEY`
- protect `/admin/*` with `ADMIN_API_KEY`
- keep `/oauth/callback` reachable by eBay
- optionally place `/`, `/oauth/start`, and `/admin/*` behind Cloudflare Access
- keep `/health` available if needed by Render health checks

---

## Hosted MCP Client Configuration

The hosted server implements a full **MCP OAuth 2.1 authorization server** (RFC 8414 / RFC 7591 / RFC 6749 + PKCE). MCP clients that support OAuth discovery — such as Cline — will handle the full browser-based eBay login flow automatically with no manual token pasting required.

Replace `https://your-server.com` with your actual `PUBLIC_BASE_URL`.

### Cline (recommended — full OAuth auto-discovery)

Cline supports OAuth 2.1 discovery natively. Just point it at the MCP endpoint and it handles everything:

```json
{
  "mcpServers": {
    "ebay": {
      "url": "https://your-server.com/mcp"
    }
  }
}
```

**What happens automatically:**
1. Cline fetches `/.well-known/oauth-authorization-server` to discover the auth server.
2. It registers itself at `POST /register` (Dynamic Client Registration).
3. Your browser opens `GET /authorize`, which redirects to eBay's login page.
4. After you grant access, eBay redirects to `/oauth/callback`, which issues an MCP auth code and sends it back to Cline.
5. Cline exchanges the code at `POST /token` for a session token and stores it.
6. All subsequent `/mcp` requests are authenticated automatically.

> **`OAUTH_START_KEY` note:** If your server has `OAUTH_START_KEY` set, the `/authorize` endpoint also requires it. You can temporarily disable it for first-time client setup, or consult your server operator for the key.

### Claude Desktop (HTTP remote with pre-obtained session token)

Claude Desktop's remote MCP support requires an explicit `Authorization` header. Complete the browser OAuth flow at `https://your-server.com/oauth/start` first to get your session token, then configure:

```json
{
  "mcpServers": {
    "ebay": {
      "url": "https://your-server.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SESSION_TOKEN"
      }
    }
  }
}
```

### Cursor (HTTP remote with pre-obtained session token)

```json
{
  "mcpServers": {
    "ebay": {
      "url": "https://your-server.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SESSION_TOKEN"
      }
    }
  }
}
```

### Make / Zapier / TypingMind and similar platforms

These platforms use a fixed token field. To connect:

1. Open `https://your-server.com/oauth/start?env=production` in a browser.
2. Complete the eBay login flow.
3. Copy the session token from the confirmation page.
4. Paste it as your **API Key / Bearer token** in the platform's MCP connector settings.
5. Set the MCP endpoint URL to `https://your-server.com/mcp`.

---

## Configuration

### Environment Variables

Local mode still supports the classic environment-variable model:

```bash
EBAY_CLIENT_ID=your_client_id
EBAY_CLIENT_SECRET=your_client_secret
EBAY_ENVIRONMENT=sandbox|production
EBAY_REDIRECT_URI=your_runame
EBAY_MARKETPLACE_ID=EBAY_COUNTRY
EBAY_CONTENT_LANGUAGE=lang_COUNTRY
EBAY_USER_REFRESH_TOKEN=your_refresh_token
```

Other supported env vars used by the current runtime:

```bash
MCP_HOST=0.0.0.0        # optional HTTP bind host
EBAY_TOKEN_STORE_PATH=.ebay-user-tokens.json   # legacy single-user file token store path
```

Notes:
- `EBAY_TOKEN_STORE_PATH` is part of the older local file-token-store path and is **not** used by the hosted multi-user KV/Redis auth flow.

Token env vars such as `EBAY_USER_REFRESH_TOKEN`, `EBAY_USER_ACCESS_TOKEN`, and `EBAY_APP_ACCESS_TOKEN`
should be treated as local single-user inputs or explicit manual override flows.
In hosted multi-user mode, OAuth state, user tokens, and session tokens are persisted in the configured
remote store (Cloudflare KV or Upstash Redis), not in environment variables.

For multi-user local or hosted deployments, use a persistent auth store:

- `EBAY_TOKEN_STORE_BACKEND=cloudflare-kv`, or
- `EBAY_TOKEN_STORE_BACKEND=upstash-redis`

Use `memory` only for tests or throwaway dev sessions, since all OAuth state,
user tokens, and session tokens are lost on restart.

Backend selection is driven by `EBAY_TOKEN_STORE_BACKEND` explicitly. Credentials alone do not select the backend:

- `EBAY_TOKEN_STORE_BACKEND=cloudflare-kv` → Cloudflare KV
- `EBAY_TOKEN_STORE_BACKEND=upstash-redis` → Upstash Redis

If the selected backend is missing required credentials, the server now fails loudly at startup instead of silently appearing to use the wrong store.

### OAuth Authentication

**Client Credentials:** lower-rate, application-level access.

**User Tokens:** higher-rate access for seller/member-specific operations.

For hosted mode, OAuth is handled server-side by the Render deployment.

## Available Tools

The server provides **325+ tools** across:

- Account Management
- Inventory Management
- Order Fulfillment
- Marketing & Promotions
- Analytics
- Communication
- Metadata & Taxonomy
- Developer Tools
- Token / Auth-related helper tools

For the complete tool list, see [src/tools/definitions/](src/tools/definitions/).

## Development

### Prerequisites

- Node.js >= 24.0.0
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- eBay Developer Account

### Quick Start for Contributors

```bash
git clone https://github.com/mrnajiboy/ebay-mcp-remote-edition.git
cd ebay-mcp-remote-edition
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

### Commands Reference

| Command                  | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `pnpm run build`         | Compile TypeScript to JavaScript                   |
| `pnpm start`             | Run local STDIO MCP server                         |
| `pnpm run start:http`    | Run hosted HTTP MCP server                         |
| `pnpm run dev`           | Run local server with hot reload                   |
| `pnpm run dev:http`      | Run hosted HTTP server with hot reload             |
| `pnpm test`              | Run test suite                                     |
| `pnpm run setup`         | Interactive setup wizard                           |
| `pnpm run sync`          | Sync specs, generate types, find missing endpoints |
| `pnpm run diagnose`      | Check configuration and connectivity               |
| `pnpm run check`         | Run typecheck + lint + format check                |
| `pnpm run fix`           | Auto-fix lint and format issues                    |

### About `pnpm run sync`

This command is a spec/type regeneration workflow. It is **not** an upstream git sync.

It will:

1. Download latest OpenAPI specs from eBay
2. Generate TypeScript types from specs
3. Analyze implemented vs missing endpoints
4. Produce a sync report

Run it intentionally when you want to refresh generated artifacts.

### Manual sync workflow

This fork treats sync as a repo-side maintenance workflow, not a live server feature.

Recommended manual flow:

```bash
pnpm install
pnpm run sync
pnpm run typecheck
pnpm run build
```

Then review the diff, commit the generated changes you want to keep, and deploy from Git.

## Dependency policy

This fork uses normal semver-compatible dependency ranges so fresh installs can pick up newer compatible versions automatically. The MCP SDK dependency has been bumped to a newer range so patched transitive dependencies can be resolved during install rather than requiring users to perform a manual update after cloning.

After dependency changes, validate with:

```bash
pnpm run typecheck
pnpm run build
```

## Logging

The server includes Winston-based logging for easier debugging.

### Log Levels

```bash
EBAY_LOG_LEVEL=debug
```

### File Logging

```bash
EBAY_ENABLE_FILE_LOGGING=true
```

## Troubleshooting

### Hosted MCP returns 406

If your MCP test client gets `406 Not Acceptable`, include:

```text
Accept: application/json, text/event-stream
```

### OAuth browser flow

In hosted mode, browser OAuth is needed for:

- first-time account connection
- re-authorization after token expiry/revocation

For Make and TypingMind, the server currently expects users to complete browser OAuth first and then paste the issued session token into the platform's token field. The server then takes over token refresh and ongoing eBay access.

Normal MCP usage should rely on the issued session token.

### Security reminders

- Do not paste session tokens publicly
- Revoke any exposed session tokens with the admin endpoint
- Rotate exposed eBay client secrets and update your Render secret file

## Cloudflare Access recommendation

If you want browser/admin surfaces to be private to only you:

- protect `/`
- protect `/oauth/start`
- protect `/admin/*`
- keep `/oauth/callback` reachable by eBay
- keep `/mcp` outside Cloudflare Access unless your MCP client is verified to work through Cloudflare Access
- keep `/health` reachable if Render uses it for health checks

This is the recommended way to make the hosted URL effectively private without breaking OAuth callback or MCP compatibility.

## Resources

- [eBay Developer Portal](https://developer.ebay.com/)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [OAuth Setup Guide](docs/auth/)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
