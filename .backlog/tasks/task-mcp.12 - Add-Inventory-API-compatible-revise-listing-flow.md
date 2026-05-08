---
id: TASK-MCP.12
title: Add Inventory API compatible revise listing flow
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-05'
updated_date: '2026-05-05'
labels: [feature, bug, high, inventory-api]
dependencies: [TASK-MCP.10]
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
JiJi live-tested `ebay_revise_listing` against Inventory API-created listings on 2026-05-05. The current MCP `ebay_revise_listing` tool uses Trading API `ReviseFixedPriceItem`, which fails for listings created through the Inventory API offer flow.

Observed eBay response:

```text
Inventory-based listing management is not currently supported by this tool. Please refer to the tool used to create this listing.
```

Hankuk Expo's preferred listing creation flow is Inventory API:

```text
create_inventory_item -> create_offer -> publish_offer
```

Therefore, Hankuk Expo needs an Inventory API-compatible revise/update listing flow. This may be a new tool, a changed description for `ebay_revise_listing`, or a higher-level wrapper that routes based on listing origin.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- Agent-facing docs clearly state `ebay_revise_listing` only works for Trading API-created fixed-price listings, OR the tool auto-routes Inventory API listings to the correct Inventory API update path.
- Add an Inventory API-native revise/update workflow using one or more of:
  - `update_offer` for price, quantity, policies, listing description, category/marketplace offer data
  - create/replace inventory item or a new update inventory item tool for product/aspect/image data
  - `bulk_update_price_quantity` if fixed/validated for price and quantity operations
- Live test verifies updating an Inventory API offer/listing without Trading API revise.
- n8n sync spec references the Inventory API update path for listing changes.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
High — n8n 2-way listing sync needs a reliable update/revise path for inventory-created listings.
<!-- SECTION:PRIORITY:END -->

## Test Evidence

<!-- SECTION:TEST_EVIDENCE:BEGIN -->
- `ReviseFixedPriceItem` on dummy listing `178107350213`: FAIL with inventory-based listing unsupported message.
- `EndFixedPriceItem` on same listing: PASS.
- `update_offer` on unpublished dummy offer `161549511011`: PASS, price changed to 10.49 and quantity to 1.
- `bulk_update_price_quantity` on unpublished dummy offer: FAIL with eBay 500 system error; needs separate investigation before use.
- Full report: `.backlog/decisions/jiji-mcp-remaining-tools-live-test-2026-05-05.md`
<!-- SECTION:TEST_EVIDENCE:END -->
