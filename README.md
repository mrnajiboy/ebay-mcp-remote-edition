# eBay API MCP Server+

<div align="center">

[![npm version](https://img.shields.io/npm/v/ebay-mcp)](https://www.npmjs.com/package/ebay-mcp)
[![npm downloads](https://img.shields.io/npm/dm/ebay-mcp)](https://www.npmjs.com/package/ebay-mcp)
[![Tests](https://img.shields.io/badge/tests-958%20passing-brightgreen)](tests/)
[![API Coverage](https://img.shields.io/badge/API%20coverage-100%25-success)](src/tools/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server providing AI assistants with comprehensive access to eBay's Sell APIs. Includes **325+ tools** for inventory management, order fulfillment, marketing campaigns, analytics, developer tools, and more.

**API Coverage:** 100% (270+ unique eBay API endpoints)

</div>

---

## Fork additions in this deployment-focused version

This fork preserves the original local/STDIO workflow while adding hosted multi-user support for a [Render](https://www.google.com/search?q=render.com&sourceid=chrome&ie=UTF-8) or similar remote server instance.

### Added in this fork

- Hosted HTTP MCP deployment mode for Render
- Multi-user server-side eBay OAuth for both production and sandbox
- Cloudflare KV-backed storage for:
  - OAuth state
  - user token records
  - session records
- Session-token based MCP auth:
  - `Authorization: Bearer <session-token>`
- Render Secret File support for environment-specific credentials
- Admin session inspection/revocation endpoints
- `GET /whoami` endpoint for session-bound identity lookup
- Optional `OAUTH_START_KEY` protection for `/oauth/start`

---

## One-Click AI Setup

> **Let your AI assistant set this up for you!** Copy the prompt below and paste it into Claude, ChatGPT, or any AI assistant with MCP support.

<details>
<summary><strong>Click to copy the AI setup prompt</strong></summary>

```text
I want to set up the eBay MCP Server for my AI assistant. Please help me:

1. Install the eBay MCP server:
   npm install -g ebay-mcp

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
- [Hosted Render Deployment](#hosted-render-deployment)
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
- **Interactive Setup Wizard** - Run `npm run setup` for guided local configuration
- **Developer Analytics** - Rate limit monitoring and signing key management

## Quick Start

### 1. Get eBay Credentials

1. Create a free [eBay Developer Account](https://developer.ebay.com/)
2. Generate application keys in the [Developer Portal](https://developer.ebay.com/my/keys)
3. Save your **Client ID** and **Client Secret**
4. Configure environment-specific RuNames for production and sandbox as needed

### 2. Install

**Option A: Install from npm**

```bash
npm install -g ebay-mcp
```

**Option B: Install from source**

```bash
git clone https://github.com/mrnajiboy/ebay-mcp.git
cd ebay-mcp
npm install
npm run build
```

### 3. Run Local Setup Wizard

For local/STDIO usage:

```bash
npm run setup
```

### 4. Hosted Mode

For hosted Render usage, see the next section.

---

## Hosted Render Deployment

### Build command

```bash
npm install && npm run build
```

### Start command

```bash
npm run start:http
```

### Render environment variables

```bash
NODE_VERSION=INT
PORT=3000
PUBLIC_BASE_URL=https://your-server.com
EBAY_CONFIG_FILE=/etc/secrets/ebay-config.json
EBAY_DEFAULT_ENVIRONMENT=sandbox|production
EBAY_TOKEN_STORE_BACKEND=cloudflare-kv
CLOUDFLARE_ACCOUNT_ID=ID
CLOUDFLARE_KV_NAMESPACE_ID=ID
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
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

After successful callback, the app issues a session token and displays it in a copy-friendly callback page.

Use it in your MCP client:

```text
Authorization: Bearer <session-token>
```

For Make and TypingMind, the practical supported flow is:

1. complete browser OAuth via the hosted server
2. copy the returned session token from the callback page
3. paste it into the platform's API Key / Access token field

Normal MCP usage should not open a browser window once a valid hosted session token already exists.

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
- npm or pnpm
- eBay Developer Account

### Quick Start for Contributors

```bash
git clone https://github.com/mrnajiboy/ebay-mcp.git
cd ebay-mcp
npm install
npm run build
npm run typecheck
npm test
```

### Commands Reference

| Command            | Description                                        |
| ------------------ | -------------------------------------------------- |
| `npm run build`    | Compile TypeScript to JavaScript                   |
| `npm start`        | Run local STDIO MCP server                         |
| `npm run start:http` | Run hosted HTTP MCP server                       |
| `npm run dev`      | Run local server with hot reload                   |
| `npm run dev:http` | Run hosted HTTP server with hot reload             |
| `npm test`         | Run test suite                                     |
| `npm run setup`    | Interactive setup wizard                           |
| `npm run sync`     | Sync specs, generate types, find missing endpoints |
| `npm run diagnose` | Check configuration and connectivity               |
| `npm run check`    | Run typecheck + lint + format check                |
| `npm run fix`      | Auto-fix lint and format issues                    |

### About `npm run sync`

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
npm install
npm run sync
npm run typecheck
npm run build
```

Then review the diff, commit the generated changes you want to keep, and deploy from Git.

## Dependency policy

This fork uses normal semver-compatible dependency ranges so fresh installs can pick up newer compatible versions automatically. The MCP SDK dependency has been bumped to a newer range so patched transitive dependencies can be resolved during install rather than requiring users to perform a manual update after cloning.

After dependency changes, validate with:

```bash
npm run typecheck
npm run build
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
