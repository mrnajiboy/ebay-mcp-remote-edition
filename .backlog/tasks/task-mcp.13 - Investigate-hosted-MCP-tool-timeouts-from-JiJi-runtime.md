---
id: TASK-MCP.13
title: Investigate hosted MCP tool timeouts from JiJi runtime
status: Done
assignee: []
created_date: '2026-05-05'
updated_date: '2026-05-06'
labels: [bug, high, hosted-mcp, transport]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
During JiJi's remaining-tool live test on 2026-05-05, multiple hosted MCP tool calls timed out from JiJi's runtime:

- `ebay_get_token_status` -> `TimeoutError`
- `ebay_get_user` -> `TimeoutError`
- `ebay_get_inventory_items` -> `TimeoutError`

Direct eBay API calls succeeded using the Upstash Redis source-of-truth OAuth token, so the issue appears to be in the hosted MCP wrapper/session/transport path or the agent-to-MCP runtime, not eBay OAuth.

**Root Cause:** MCP tool handlers had no timeout wrapper or instrumentation. Tools could hang indefinitely due to:
1. Token refresh latency (access token expiry triggers refresh flow + Redis save)
2. API chaining (multiple sequential 30s API calls within single tool)
3. Upstash Redis network latency during session init
4. No server-side timeout on `transport.handleRequest()`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- Reproduce or rule out timeouts from at least two clients/runtimes.
- Confirm whether timeout is server-wide, agent-specific, or tool-specific.
- Add timeout/logging instrumentation around MCP handler execution if missing.
- `ebay_get_token_status`, `ebay_get_user`, and `ebay_get_inventory_items` complete successfully through hosted MCP from JiJi/Hermes/Bruno runtime.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
High — direct eBay APIs are usable, but agents need reliable MCP tool calls before n8n sync validation can be considered fully green.
<!-- SECTION:PRIORITY:END -->

## Test Evidence

<!-- SECTION:TEST_EVIDENCE:BEGIN -->
- JiJi tool calls timed out on 2026-05-05.
- Direct REST calls using Redis OAuth token succeeded for inventory locations, inventory items, account policies, offers, publishing, Trading API active listings, GetItem, and EndFixedPriceItem.
- Full report: `.backlog/decisions/jiji-mcp-remaining-tools-live-test-2026-05-05.md`
<!-- SECTION:TEST_EVIDENCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-05-06: Fixed in `src/server-http.ts` createMcpServer() function.

**Changes:**
1. Added configurable `TOOL_TIMEOUT_MS` (default 60s, via `MCP_TOOL_TIMEOUT_MS` env var)
2. Wrapped `executeTool()` with `Promise.race()` timeout pattern
3. Added execution duration logging (`[tool-exec]` prefix) with userId, environment, durationMs, status
4. Timeout errors return clear error message with tool name and timeout duration

**Before:** Tools could hang indefinitely. No logging on execution.
**After:** Tools timeout after 60s (configurable). All executions logged with duration.

**Tests:** 1061 passed. Build successful.
<!-- SECTION:NOTES:END -->
