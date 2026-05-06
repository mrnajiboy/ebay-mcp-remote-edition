# Agent Guide for eBay MCP — Remote Edition

> **Purpose:** Orients AI agents on project structure, conventions, and work queue. Read before making changes.

---

## 1. Project Overview

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server exposing **325+ tools** covering eBay's Sell APIs.

| Mode | Transport | Use Case |
|------|-----------|----------|
| **Local STDIO** | stdin/stdout | Single-user local AI clients |
| **Hosted HTTP** | Streamable HTTP | Multi-user deployments (Render, Railway, Coolify) |

Key capabilities: 270+ unique endpoints, OAuth 2.1 auth, Cloudflare KV / Upstash Redis storage, validation pipeline (browse, sold, Terapeak, social signals), eBay Research session with QStash-triggered Telegram alerts.

---

## 2. Architecture

```
src/
├── index.ts                    # STDIO entry point
├── server-http.ts              # HTTP entry point (Express + MCP Streamable HTTP)
├── api/
│   ├── client.ts               # REST client for eBay Sell APIs
│   ├── client-trading.ts       # XML/SOAP client for Trading API
│   └── */                      # Domain-specific modules
├── tools/
│   ├── definitions/            # MCP tool definitions (Zod schemas)
│   ├── tool-definitions.ts     # Tool registration + routing
│   └── schemas.ts              # Shared Zod schemas
├── validation/
│   ├── run-validation.ts       # Validation orchestration
│   ├── recommendation.ts       # Buy/track decision logic
│   ├── types.ts                # Request/response contracts
│   └── providers/              # Providers (ebay, ebay-sold, terapeak, social, research, chart)
├── config/environment.ts       # Environment variable resolution
├── auth/oauth.ts               # OAuth 2.1 flows, token refresh, sessions
├── scripts/                    # Research session scripts + Playwright check
└── utils/                      # Logging, security, date conversion
```

**Conventions:** TypeScript strict mode, Zod for validation, fast-xml-parser for Trading API XML, Playwright for research sessions, all records carry `expiresAt` + backend TTL.

---

## 3. Backlog System

Markdown-based backlog in [`.backlog/`](.backlog). See [backlog system docs](.backlog/) for format and agent responsibilities.

```
.backlog/
├── tasks/       # task-{id} - {slug}.md files
└── decisions/   # {decision-slug}.md
```

**Agent workflow:** Check `.backlog/tasks/` before starting work → update `status` + `updated_date` when changing state → create decision files for non-trivial architectural choices.

---

## 4. Active Tasks Summary

Full details in `.backlog/tasks/` and AGENTS.md in parent repo (`../..`).

| Task | Status | Notes |
|------|--------|-------|
| TASK-MCP.1 — Fix XML generation | ✅ Done (May 4) | Trading API XML transform + validation |
| TASK-MCP.2 — Business Policy setup | ✅ Done (May 3) | Guidance documented |
| TASK-MCP.3 — Schema enum mismatch | ✅ Done (May 5) | `normalizeTimeUnit()` fix |
| TASK-MCP.4 — upload_images dual endpoint | ✅ Done (May 5) | imageUrls + imageFiles |
| TASK-MCP.5 — OAuth multi-env | ✅ Done (May 5) | EBAY_PRODUCTION_*/SANDBOX_* |
| TASK-MCP.6 — Disable unsupported tools | ✅ Done (May 6) | Config-level `tools.exclude` filter |
| TASK-MCP.7 — publish_offer XML transform | ✅ Done (May 5) | Pre-transform logic |
| TASK-MCP.8 — Taxonomy API tools | ✅ Done (May 5) | Category tree, suggestions, specifics |
| TASK-MCP.9 — Browse API tools | ✅ Done (May 5) | Suggestions, product search, item specifics |
| TASK-MCP.10 — update_inventory_item | ✅ Done (May 5) | Deep-merge pattern |
| TASK-MCP.11 — get_offers schema | ✅ Done (May 5) | SKU parameter required |
| TASK-MCP.12 — revise_listing fallback | ✅ Done (May 5) | Trading → Inventory API auto-route |
| TASK-MCP.13 — Hosted MCP timeouts | 🔲 To Do | JiJi runtime investigation |
| TASK-MCP.14 — publish_offer policies + images | ✅ Done (May 6) | listingPolicies injection + Location header parsing |
| TASK-MCP.15 — Image enlargement with Sharp | ✅ Done (May 6) | Sub-500px auto-enlargement pipeline |
| TASK-MCP.16 — publish_offer Trading API | ✅ Done (May 6) | createListing() with XML transform + Inventory API fallback |

---

## 5. Development Workflow

```bash
pnpm install && pnpm run build && pnpm run typecheck && pnpm test
```

**Running:** `pnpm start` (STDIO), `pnpm run start:http` (HTTP), `pnpm run dev` (hot reload)

**Adding tools:** Define Zod schema → register in `tool-definitions.ts` → implement API call in `src/api/` → add tests → `pnpm run build && pnpm test`

**Environment:** Copy `.env.example` → `.env`, fill `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, `EBAY_ENVIRONMENT`.

---

## 6. Testing

```bash
pnpm test                           # Unit tests
curl https://your-server.com/health # Hosted health
```

See `README.md` for full health check and research session commands.

---

## 7. Common Pitfalls

1. **Console in STDIO mode** — Use `src/utils/logger.ts`, not `console.log` (corrupts MCP protocol)
2. **Missing Business Policies** — `ebay_create_offer` requires fulfillment/payment/return policies (TASK-MCP.2)
3. **Trading API XML nesting** — Use explicit transform functions, not raw fast-xml-parser (TASK-MCP.1)
4. **OAuth state expiry** — 15-minute window; restart browser flow if expired
5. **mkcert CA trust** — Set `NODE_EXTRA_CA_CERTS` for local HTTPS (see README.md)

---

## 8. Resources

- [`README.md`](README.md) — Setup, deployment, troubleshooting
- [`CHANGELOG.md`](CHANGELOG.md) — Release history
- [`.backlog/`](.backlog) — Tasks and decisions
- [`docs/auth/`](docs/auth/) — Auth configuration
- [`docs/API_STATUS.md`](docs/API_STATUS.md) — Endpoint coverage

**Parent repo:** `../..` — Root AGENTS.md has platform-level context (Airtable sync, n8n, Telegram, operational workflow)

**Skills:** `ebay-mcp-server`, `ebay-publish-workflow`, `airtable-ebay-sync`

---

*Last updated: 2026-05-06*
