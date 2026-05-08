---
id: TASK-MCP.7
title: Fix publish_offer XML transform
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-05'
updated_date: '2026-05-05'
labels: [bug, medium]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`ebay_publish_offer` uses Trading API but doesn't call `transformItemForXML()` like `create_listing` does. The XML request is missing required fields (Country, etc.), causing:

```
A user error has occurred. No <Item.Country> exists or <Item.Country> is specified as an empty tag in the request.
```

Apply the same `transformItemForXML()` fix that was deployed for `create_listing` (TASK-MCP.1) to `publish_offer`.
<!-- SECTION:DESCRIPTION:END -->

## Resolution

Pre-transform logic added to `src/tools/index.ts` handler (lines 882-903): fetches the offer → gets the inventory item by SKU → applies `transformItemForXML` → updates inventory item → proceeds with publish. Non-fatal error handling ensures publish continues even if pre-transform fails.

Commit: `d56ba42 fix: TASK-MCP.7 - publish_offer XML transform bug`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_publish_offer` calls `transformItemForXML()` before sending request
- Published offer includes all required Trading API XML fields (Country, etc.)
- UNPUBLISHED offers can be successfully published via MCP
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Medium — fallback `ebay_create_listing` exists but not live-tested
<!-- SECTION:PRIORITY:END -->
