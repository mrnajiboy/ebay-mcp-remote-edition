# Agent Guide for eBay MCP — Remote Edition

> **Purpose:** This document orients AI agents (Roo, Claude, Gemini, etc.) on the project structure, conventions, and current work queue. Read this before making changes.

---

## 1. Project Overview

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes **325+ tools** covering eBay's Sell APIs. It supports two runtime modes:

| Mode | Transport | Use Case |
|------|-----------|----------|
| **Local STDIO** | stdin/stdout | Single-user local AI clients (Claude Desktop, Cline, Cursor, Roo Code, etc.) |
| **Hosted HTTP** | Streamable HTTP | Multi-user server deployments (Render, Railway, Coolify, etc.) |

Key capabilities:
- Full eBay Sell API coverage (270+ unique endpoints)
- OAuth 2.1 authorization server with browser-based eBay login
- Environment-scoped route trees (`/sandbox/mcp`, `/production/mcp`)
- Cloudflare KV / Upstash Redis token and session storage
- Admin session management endpoints
- Validation pipeline for marketplace analysis (browse, sold, Terapeak, social signals)
- eBay Research session persistence with QStash-triggered Telegram alerts

---

## 2. Architecture at a Glance

```
src/
├── index.ts                    # Local STDIO entry point
├── server-http.ts              # Hosted HTTP entry point (Express + MCP Streamable HTTP)
├── api/
│   ├── client.ts               # REST API client for eBay Sell APIs
│   ├── client-trading.ts       # XML/SOAP client for eBay Trading API
│   └── */                      # Domain-specific API modules (account, inventory, fulfillment, etc.)
├── tools/
│   ├── definitions/            # MCP tool definitions (Zod schemas + metadata)
│   ├── tool-definitions.ts     # Tool registration and routing
│   └── schemas.ts              # Shared Zod schemas
├── validation/
│   ├── run-validation.ts       # Validation orchestration entrypoint
│   ├── recommendation.ts       # Buy/track decision logic
│   ├── types.ts                # Validation request/response contracts
│   └── providers/              # Provider implementations (ebay, ebay-sold, terapeak, social, research, chart)
├── config/
│   └── environment.ts          # Environment variable resolution and eBay config
├── auth/
│   └── oauth.ts                # OAuth 2.1 flows, token refresh, session management
├── scripts/
│   ├── bootstrap-ebay-research-session.ts
│   ├── inspect-ebay-research-session.ts
│   └── check-playwright.ts
└── utils/                      # Logging, security, date conversion, etc.
```

### Key Conventions

- **TypeScript strict mode** is enabled.
- **Zod** is used for all input validation and schema generation.
- **fast-xml-parser** handles XML for the Trading API.
- **Playwright** is used for authenticated eBay Research session bootstrapping.
- All stored records (OAuth state, auth codes, sessions, tokens) carry `expiresAt` and a matching backend TTL.

---

## 3. Backlog System

This project uses a lightweight markdown-based backlog in [`.backlog/`](.backlog). Agents should read, update, and create backlog items as part of normal workflow.

### Directory Structure

```
.backlog/
├── tasks/
│   └── task-{id} - {slug}.md
└── decisions/
    └── {decision-slug}.md
```

### Task File Format

Every task is a markdown file with YAML front matter:

```markdown
---
id: TASK-MCP.1
title: Fix ebay_create_listing XML generation
status: To Do        # To Do | In Progress | Done
assignee: []
created_date: '2026-05-03'
updated_date: '2026-05-03'
labels: [bug, critical]
dependencies: [TASK-MCP.1.1, TASK-MCP.1.2]
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tool passes JSON directly to fast-xml-parser which generates invalid XML for eBay Trading API.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_create_listing` successfully creates a listing on eBay with proper XML structure.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Critical
<!-- SECTION:PRIORITY:END -->
```

### Decision File Format

Decisions are narrative markdown files explaining *why* a change was made or proposed:

```markdown
# Title

## Problem
## Files to Change
## Proposed Patch
## Alternative Approaches
## Testing
## Related
```

### Agent Responsibilities

1. **Before starting work:** Check `.backlog/tasks/` for active items related to your assignment.
2. **When creating a task:** Use the naming convention `task-{id} - {slug}.md` and include all front-matter fields.
3. **When updating a task:** Change `status` to `In Progress` or `Done`, and update `updated_date`.
4. **When making architectural choices:** Create a decision file in `.backlog/decisions/` if the choice is non-trivial.
5. **When completing a task:** Ensure acceptance criteria are met, then mark `status: Done`.

---

## 4. Current Active Backlog

### TASK-MCP.1 — Fix ebay_create_listing XML Generation
- **Status:** ✅ Done (May 4, 2026)
- **Priority:** Critical
- **Labels:** bug, critical
- **Dependencies:** TASK-MCP.1.1, TASK-MCP.1.2
- **Decision:** [`.backlog/decisions/ebay-create-listing-xml-fix.md`](.backlog/decisions/ebay-create-listing-xml-fix.md)

**Problem:** `ebay_create_listing` fails because `z.record(z.string(), z.unknown())` accepts any input without validating structure. When passed to `fast-xml-parser`'s XMLBuilder, nested objects produce malformed XML.

**Subtasks:**
- **TASK-MCP.1.1** — Add input validation schema for Trading API item fields. ✅ Done
- **TASK-MCP.1.2** — Fix XML generation for nested fields. ✅ Done

---

### TASK-MCP.2 — Add eBay Business Policy Setup Guidance
- **Status:** ✅ Done (May 3, 2026)
- **Priority:** Medium
- **Labels:** medium

**Resolution:** Setup guidance documented. `ebay_create_offer` succeeds once fulfillment/payment/return policies are configured.

---

### TASK-MCP.3 — Fix create_fulfillment_policy Schema Enum Mismatch
- **Status:** ✅ Done (May 5, 2026)
- **Priority:** High
- **Labels:** bug, high

**Resolution:** Changed `timeDurationSchema.unit` from `z.nativeEnum()` to `z.string()`. Handler's `normalizeTimeUnit()` converts "day"/"days" → "DAY" before API call. Zod validates before handler runs, so nativeEnum rejected LLM input formats.

---

### TASK-MCP.4 — Add Dual Endpoint Support to ebay_upload_images
- **Status:** ✅ Done (May 5, 2026 — commit 8662369)
- **Priority:** High
- **Labels:** bug, high

**Resolution:** Added `createImageFromFile()` to MediaApi — uploads local files via multipart/form-data. Tool definition accepts both `imageUrls` and `imageFiles`. Handler dispatches based on input.

---

### TASK-MCP.5 — OAuth Multi-Environment Support
- **Status:** ✅ Done (May 5, 2026 — commit 6884f3c)
- **Priority:** Medium
- **Labels:** bug, medium

**Resolution:** Handler uses `getEbayConfig()` which supports multi-env vars (EBAY_PRODUCTION_*/EBAY_SANDBOX_*). Added optional `environment` parameter. Defaults to PRODUCTION.

---

### TASK-MCP.6 — Disable Unsupported Tools for All Agents
- **Status:** To Do
- **Priority:** Medium
- **Labels:** config, medium

**Problem:** Commerce Shipping, VERO, and signing key tools are unsupported by our account. Disable for all agents.

---

### TASK-MCP.7 — Fix publish_offer XML Transform
- **Status:** ✅ Done (May 5, 2026 — commit d56ba42)
- **Priority:** Medium
- **Labels:** bug, medium

**Resolution:** Pre-transform logic added to handler: fetches offer → gets inventory item → applies `transformItemForXML` → updates inventory → publishes. Non-fatal error handling.

---

### TASK-MCP.8 — Add Missing Taxonomy API Tools (Feature)
- **Status:** ✅ Done (May 5, 2026)
- **Priority:** Feature
- **Labels:** feature

**Resolution:** Added `ebay_get_default_category_tree_id`, `ebay_get_category_tree`, `ebay_get_category_suggestions`, `ebay_get_item_aspects_for_category`, `ebay_get_category`.

---

### TASK-MCP.9 — Add Missing Browse API Tools (Feature)
- **Status:** ✅ Done (May 5, 2026)
- **Priority:** Feature
- **Labels:** feature

**Resolution:** Added `ebay_get_suggestions`, `ebay_search_products`, `ebay_get_item_specifics`.

---

### TASK-MCP.10 — Add ebay_update_inventory_item Tool (Feature)
- **Status:** ✅ Done (May 5, 2026)
- **Priority:** Feature
- **Labels:** feature

**Resolution:** Deep-merge pattern: fetch existing item → merge user-provided updates → createOrReplace. Supports partial updates (price, quantity, title, etc.).

---

### TASK-MCP.11 — Fix ebay_get_offers Schema (Bug)
- **Status:** ✅ Done (May 5, 2026)
- **Priority:** Medium
- **Labels:** bug, medium, inventory-api

**Resolution:** Schema now requires `sku` parameter. Tool description clearly states it lists offers for a specific SKU. Without SKU, eBay returns error 25707.

---

### TASK-MCP.12 — Inventory API Fallback for ebay_revise_listing (Feature)
- **Status:** ✅ Done (May 5, 2026)
- **Priority:** High
- **Labels:** feature, bug, high, inventory-api

**Resolution:** `ebay_revise_listing` tries Trading API first. On inventory-backed listing failure, auto-routes to Inventory API: `update_offer()` for price/quantity/description, `createOrReplaceInventoryItem()` for title. Returns detailed result with `updatedFields` list.

---

### TASK-MCP.13 — Investigate Hosted MCP Tool Timeouts (Bug)
- **Status:** To Do
- **Priority:** High
- **Labels:** bug, high, hosted-mcp, transport

**Problem:** Multiple hosted MCP tool calls timed out from JiJi runtime (`ebay_get_token_status`, `ebay_get_user`, `ebay_get_inventory_items`). Direct eBay API calls using Redis OAuth token succeeded — issue appears to be in hosted MCP wrapper/transport path.

---

### TASK-MCP.14 — Fix publish_offer listingPolicies and upload_images (Bug)
- **Status:** ✅ Done (May 6, 2026 — commit 71090b9)
- **Priority:** High
- **Labels:** bug, high

**Resolution:** Two bugs fixed during live smoke testing:
1. `publish_offer` pre-publish handler now auto-injects `listingPolicies` (payment/return/fulfillment policy IDs) when missing. ⚠️ Policy IDs hardcoded for Hankuk Expo account only.
2. `upload_images` response parsing fixed — `createImageFromUrl` now correctly extracts image ID from Location header. `getImage()` converts `$_1.JPG` thumbnail to `s-l1600.jpg` full-size URL automatically.

**Smoke test results (May 6):** All core tools verified working — `create_inventory_item`, `create_offer`, `publish_offer`, `upload_images`, `revise_listing`, `withdraw_offer`, `delete_offer`, `get_active_listings`.

---

### TASK-MCP.15 — Fix createImageFromUrl to process images with Sharp before upload (Bug)
- **Status:** ✅ Done (May 6, 2026 — commit TBD)
- **Priority:** Critical
- **Labels:** bug, critical, images

**Problem:** `createImageFromUrl` bypassed Sharp image processing — URLs passed directly to eBay, so sub-500px images were rejected by `publish_offer` with "please upload high-resolution photos that are at least 500 pixels on the longest side".

**Solution:** Rewrote `createImageFromUrl` to:
1. **Download** image from source URL (axios, max 10MB)
2. **Process** via `processImageForUpload()` (Sharp: enlarges if <500px, converts to JPEG @90%)
3. **Upload** via `uploadProcessedImage()` (multipart/form-data)

**Impact:** Images <500px on longest side are automatically enlarged to minimum 500px using Sharp's `resize()` with `withoutEnlargement: false`. All images converted to JPEG at 90% quality before upload. Images >4800px still downsized.

**Testing:** 1061/1061 tests pass ✅

**Next:** Live integration test pending — Bruno MCP client stalled during draft workflow test (May 6). Jiji + Bruno retrying.

---

## 5. Development Workflow

### Build & Test

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

### Running Locally

```bash
# STDIO mode (for local MCP clients)
pnpm start

# HTTP mode (for hosted deployments)
pnpm run start:http

# With hot reload
pnpm run dev
pnpm run dev:http
```

### Environment Setup

Copy [`.env.example`](.env.example) to `.env` and fill in:
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME`
- `EBAY_ENVIRONMENT` (sandbox or production)

For hosted mode, see the **Secret file** section in [`README.md`](README.md).

### Adding or Modifying Tools

1. Define the Zod schema in the appropriate file under [`src/tools/definitions/`](src/tools/definitions/).
2. Register the tool in [`src/tools/tool-definitions.ts`](src/tools/tool-definitions.ts).
3. Implement the API call in the relevant [`src/api/`](src/api/) module.
4. Add unit tests in [`tests/unit/`](tests/unit/).
5. Run `pnpm run build && pnpm test`.

### Validation Pipeline Changes

The validation stack is split into **server-side authenticated providers** and **orchestration-side research providers**:

- **Server-side:** [`src/validation/providers/ebay.ts`](src/validation/providers/ebay.ts), [`ebay-sold.ts`](src/validation/providers/ebay-sold.ts), [`terapeak.ts`](src/validation/providers/terapeak.ts)
- **Orchestration-side:** [`src/validation/providers/research.ts`](src/validation/providers/research.ts), [`social.ts`](src/validation/providers/social.ts), [`chart.ts`](src/validation/providers/chart.ts)

When modifying providers:
- Update [`src/validation/types.ts`](src/validation/types.ts) if contracts change.
- Update [`src/validation/run-validation.ts`](src/validation/run-validation.ts) if merge precedence changes.
- Update [`src/validation/recommendation.ts`](src/validation/recommendation.ts) if decision logic changes.

---

## 6. Testing & Validation

### Unit Tests

```bash
pnpm test
```

### Hosted Health Checks

```bash
# Server health
curl https://your-server.com/health

# Session identity
curl -H "Authorization: Bearer <token>" https://your-server.com/whoami

# Validation runner health
curl https://your-server.com/sandbox/validation/health \
  -H "X-Admin-API-Key: YOUR_ADMIN_API_KEY"
```

### eBay Research Session

```bash
# Check browser availability
pnpm run research:check-browser

# Bootstrap a new session
pnpm run research:bootstrap

# Inspect stored session
pnpm run research:inspect-session
```

---

## 7. Common Pitfalls

1. **Console output in STDIO mode** — Never use `console.log`/`console.error` in the STDIO path. It corrupts the MCP JSON protocol. Use the logger in [`src/utils/logger.ts`](src/utils/logger.ts) instead.
2. **Missing Business Policies** — `ebay_create_offer` requires fulfillment, payment, and return policies on the eBay account. See TASK-MCP.2.
3. **Trading API XML nesting** — `fast-xml-parser` does not automatically produce eBay-compatible nested XML. Always use explicit transform functions (see TASK-MCP.1.2).
4. **OAuth state expiry** — OAuth state records expire in 15 minutes. If "Invalid or expired OAuth state" appears, restart the browser flow.
5. **mkcert CA trust** — Node.js does not read the macOS system keychain. Set `NODE_EXTRA_CA_CERTS` when using local HTTPS (see [`README.md`](README.md) Prerequisites).

---

## 8. Resources

- [`README.md`](README.md) — Full setup, deployment, and troubleshooting guide
- [`CHANGELOG.md`](CHANGELOG.md) — Release history and breaking changes
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution guidelines
- [`SECURITY.md`](SECURITY.md) — Security policy and reporting
- [`docs/auth/CONFIGURATION.md`](docs/auth/CONFIGURATION.md) — Auth configuration details
- [`docs/auth/OAUTH_QUICK_REFERENCE.md`](docs/auth/OAUTH_QUICK_REFERENCE.md) — OAuth quick reference
- [`docs/API_STATUS.md`](docs/API_STATUS.md) — Implemented vs missing endpoints

---

*Last updated: 2026-05-06 (backlog status reconciled)*
