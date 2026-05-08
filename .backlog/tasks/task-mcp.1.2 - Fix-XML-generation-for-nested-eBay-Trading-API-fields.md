---
id: TASK-MCP.1.2
title: Fix XML generation for nested eBay Trading API fields
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-03'
updated_date: '2026-05-03'
labels: [bug, high]
dependencies: []
parent_task_id: TASK-MCP.1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ensure PrimaryCategory, ShippingDetails, ReturnPolicy, PicturesDetails, ItemSpecifics are properly converted to nested XML structure that eBay Trading API expects.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- Nested objects (PrimaryCategory, ShippingDetails, ReturnPolicy, PicturesDetails, ItemSpecifics) produce valid nested XML elements.
- Generated XML passes eBay Trading API validation.
- `ebay_create_listing` returns successful listing creation response from eBay.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
High
<!-- SECTION:PRIORITY:END -->
