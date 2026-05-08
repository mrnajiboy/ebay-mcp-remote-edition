# MCP Tool Exclusion Filter

Two mechanisms exist for excluding unsupported eBay tools from the MCP server.
Use the **config-level filter** for per-agent customization. Use the
**code-level filter** only for tools that are globally unsupported across all
accounts.

---

## 1. Config-Level Filter (Recommended)

**Where:** Each Hermes agent's `config.yaml`

**Purpose:** Per-agent tool filtering — different agents can see different tool
sets without touching MCP server code.

### Enable

Add a `tools.exclude` list under the `mcp_servers.ebay-production` key:

```yaml
mcp_servers:
  ebay-production:
    tools:
      exclude:
        - ebay_get_shipping_services
        - ebay_get_dropoff_sites
```

### Disable (re-enable a tool)

Remove the tool name from the `tools.exclude` list:

```yaml
# Before — tool excluded
mcp_servers:
  ebay-production:
    tools:
      exclude:
        - ebay_get_shipping_services

# After — tool visible
mcp_servers:
  ebay-production:
    tools: {}
```

### Use

The Hermes MCP client reads `tools.exclude` at session startup and removes the
listed tools from the tool registry. Excluded tools won't appear in the LLM's
tool list — the model can't call what it can't see.

**Config locations:**
- Bruno: `~/.hermes/profiles/bruno/config.yaml`
- JiJi: `~/.hermes/profiles/jiji/config.yaml`
- Hermes main: `~/.hermes/config.yaml`

### Full Default Exclusion List

These tools are excluded because the Hankuk Expo eBay account doesn't support
them (not enrolled / no permissions):

```yaml
mcp_servers:
  ebay-production:
    tools:
      exclude:
        # Commerce Shipping — account not enrolled
        - ebay_get_shipping_services
        - ebay_get_dropoff_sites
        - ebay_get_consign_preferences
        - ebay_get_battery_qualifications
        # VERO (Vendor Enforcement of Rights Online) — account not enrolled
        - ebay_get_vero_reason_codes
        - ebay_create_vero_report
        # Signing Keys — account lacks permissions
        - ebay_suppress_violation
        - ebay_get_signing_keys
        - ebay_create_signing_key
```

---

## 2. Code-Level Filter (Server-Side Baseline)

**Where:** `src/tools/index.ts` — `EXCLUDED_TOOLS` set

**Purpose:** Server-side baseline — tools permanently excluded for all clients
regardless of config. This is a last-resort fallback; prefer config-level.

### Add a tool to the exclusion list

Edit `src/tools/index.ts`:

```typescript
const EXCLUDED_TOOLS = new Set([
  // Existing entries...
  'ebay_get_shipping_services',
  'ebay_get_dropoff_sites',
  // Add new entry:
  'ebay_my_new_unsupported_tool',
]);
```

The filter is applied in `getToolDefinitions()` (line ~347):

```typescript
return allTools.filter((tool) => !EXCLUDED_TOOLS.has(tool.name));
```

### Remove a tool from the exclusion list

Simply delete the tool name from the `EXCLUDED_TOOLS` set:

```typescript
const EXCLUDED_TOOLS = new Set([
  // ebay_get_shipping_services removed — tool now visible to all clients
  'ebay_get_dropoff_sites',
  // ...
]);
```

### Deploy

Code-level changes require a full rebuild + redeploy:

```bash
cd "MCP Servers/ebay-mcp-remote-edition"
pnpm run fix && pnpm run build && pnpm test
git add -A && git commit -m "feat: exclude ebay_my_new_unsupported_tool"
git push origin main
# Coolify auto-deploys on push
```

---

## 3. How the Filters Work Together

```
┌──────────────────────────────────────────────────┐
│  MCP Server (325+ tools)                         │
│  ┌──────────────────────────────────────────────┐│
│  │ Code-Level Filter (EXCLUDED_TOOLS)           ││
│  │ Removes: 9 permanently unsupported tools     ││
│  │ Result: ~316 tools returned to client        ││
│  └──────────────────────────────────────────────┘│
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Hermes Agent (MCP Client)                       │
│  ┌──────────────────────────────────────────────┐│
│  │ Config-Level Filter (tools.exclude)          ││
│  │ Removes: tools listed in config.yaml         ││
│  │ Result: final tool list for LLM              ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

**Precedence:** Config-level filter runs AFTER code-level filter. If a tool
is excluded at code level, it's already gone before the client sees it —
adding it to config.exclude is redundant but harmless.

---

## 4. Troubleshooting

### Tool still appearing after adding to config.exclude

1. Verify the tool name matches exactly (e.g., `ebay_get_shipping_services`,
   not `get_shipping_services`)
2. Restart the agent's MCP session (close/reopen Telegram chat or `/reset`)
3. Check that the config is under the correct `mcp_servers.ebay-production`
   key (not `ebay-sandbox` or another server)

### Tool disappeared after adding to config.exclude

Remove it from the `tools.exclude` list and restart the MCP session.

### Tool call returns 404 or "not supported"

The tool exists in the API but your account isn't enrolled. Add it to
`tools.exclude` so the LLM stops trying.

---

## 5. Audit — Current Excluded Tools

| Tool | Category | Reason |
|------|----------|--------|
| `ebay_get_shipping_services` | Commerce Shipping | Account not enrolled |
| `ebay_get_dropoff_sites` | Commerce Shipping | Account not enrolled |
| `ebay_get_consign_preferences` | Commerce Shipping | Account not enrolled |
| `ebay_get_battery_qualifications` | Commerce Shipping | Account not enrolled |
| `ebay_get_vero_reason_codes` | VERO | Account not enrolled in VERO program |
| `ebay_create_vero_report` | VERO | Account not enrolled in VERO program |
| `ebay_suppress_violation` | Signing Keys | Account lacks signing key permissions |
| `ebay_get_signing_keys` | Signing Keys | Account lacks signing key permissions |
| `ebay_create_signing_key` | Signing Keys | Account lacks signing key permissions |

**Last updated:** 2026-05-08
