---
id: TASK-MCP.11
title: Fix get_offers listing behavior
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-05'
updated_date: '2026-05-05'
labels: [bug, medium, inventory-api]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
JiJi live-tested offer retrieval on 2026-05-05. `get_offer(offerId)` works, and `get_offers` works when a valid SKU is supplied. However, calling `get_offers` without SKU returned eBay error 25707:

```text
This is an invalid value for a SKU. Only alphanumeric characters can be used for SKUs, and their length must not exceed 50 characters
```

This means the current `ebay_get_offers` tool should not be presented as a generic "list all offers" tool unless the implementation can call an eBay-supported list-all path. For Hankuk Expo's current path, it should either require `sku`, clearly document the limitation, or implement alternate pagination/listing behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_get_offers` no longer fails with invalid SKU when called without SKU, OR the schema requires `sku` and the tool description clearly says it lists offers for a SKU.
- Tool tests cover both `get_offer(offerId)` and `get_offers(sku)`.
- Agent-facing docs no longer describe `ebay_get_offers` as safe generic list-all unless verified.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Medium — n8n sync can use SKU-scoped retrieval, but agent UX currently implies list-all behavior.
<!-- SECTION:PRIORITY:END -->

## Test Evidence

<!-- SECTION:TEST_EVIDENCE:BEGIN -->
- `GET /sell/inventory/v1/offer/{offerId}`: PASS for offers `161546272011`, `161546284011`.
- `GET /sell/inventory/v1/offer?sku=<SKU>&limit=10`: PASS, count 1 for dummy SKUs.
- `GET /sell/inventory/v1/offer?limit=10`: FAIL, eBay error 25707 invalid SKU.
- Full report: `.backlog/decisions/jiji-mcp-remaining-tools-live-test-2026-05-05.md`
<!-- SECTION:TEST_EVIDENCE:END -->
