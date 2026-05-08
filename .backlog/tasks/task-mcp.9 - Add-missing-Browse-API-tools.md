---
id: TASK-MCP.9
title: Add missing Browse API tools
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-05'
updated_date: '2026-05-05'
labels: [feature]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Per Naji review: Add these missing MCP endpoints based on eBay Browse API reference:

- `ebay_get_suggestions` — Get listing/product suggestions
- `ebay_search_products` — Search product catalog
- `ebay_get_item_specifics` — Get required/optional item specifics for categories

These tools don't exist in current MCP build. Feature requests based on eBay API reference.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- All three tools registered and functional
- Zod schemas match eBay Browse API reference
- Tools return structured data usable for listing creation and validation
<!-- SECTION:ACCEPTANCE:END -->

## Resolution

Implemented BrowseApi client class at `src/api/browse/browse.ts` using the existing Browse API pattern from `src/validation/providers/ebay.ts`. Registered in `api/index.ts`, tool definitions in `src/tools/definitions/browse.ts`, handlers in `src/tools/index.ts`. All 1061 tests pass.

Commit: 0550e98 (May 5, 2026)

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Feature request — prioritize based on operational need
<!-- SECTION:PRIORITY:END -->
