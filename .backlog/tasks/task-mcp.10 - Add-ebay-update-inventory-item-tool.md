---
id: TASK-MCP.10
title: Add ebay_update_inventory_item tool
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
Per Naji review: Add `ebay_update_inventory_item` — update variant of existing `ebay_create_inventory_item`. Currently only create/delete exist, but updates are needed for inventory adjustments (price changes, quantity updates, etc.).

This tool doesn't exist in current MCP build. Feature request based on eBay Inventory API reference.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_update_inventory_item` registered and functional
- Supports partial updates (PATCH) per eBay Inventory API reference
- Zod schema matches eBay API spec
- Tool returns updated inventory item data
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Feature request — operational need for inventory adjustments
<!-- SECTION:PRIORITY:END -->
