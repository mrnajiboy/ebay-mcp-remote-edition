---
id: TASK-MCP.6
title: Disable unsupported tools for all agents
status: Done
assignee: []
created_date: '2026-05-05'
updated_date: '2026-05-06'
labels: [config, medium]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Per Naji review, disable the following tools for all agents. These are NOT bugs — our account simply doesn't support these APIs yet, or they're not relevant to our operations.

**Commerce Shipping API (account not eligible):**
- `ebay_get_shipping_services`
- `ebay_get_dropoff_sites`
- `ebay_get_consign_preferences`
- `ebay_get_battery_qualifications`
- All Commerce Shipping API tools

**VERO (not registered):**
- `ebay_get_vero_reason_codes`
- `ebay_create_vero_report`

**Signing keys (not enabled):**
- `ebay_suppress_violation`
- `ebay_get_signing_keys`
- `ebay_create_signing_key`

Approach: Config-level `tools.exclude` filter in `getToolDefinitions()` — `src/tools/index.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- Listed tools are disabled or return clear "unsupported for this account" errors
- Tool registration excludes disabled tools from agent visibility
- No agent can accidentally call unsupported tools
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Medium
<!-- SECTION:PRIORITY:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-05-06: Implemented config-level `tools.exclude` filter in `src/tools/index.ts`. Added `EXCLUDED_TOOLS` Set with 9 disabled tool names. Filter applied in `getToolDefinitions()` before returning tool list. All 1061 tests pass. Build successful.
<!-- SECTION:NOTES:END -->
