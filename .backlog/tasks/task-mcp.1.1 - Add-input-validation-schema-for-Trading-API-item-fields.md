---
id: TASK-MCP.1.1
title: Add input validation schema for Trading API item fields
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
Replace `z.record(z.string(), z.unknown())` with proper zod schema that validates required fields (Title, PrimaryCategory.CategoryID, StartPrice, ConditionID, Country, Currency, DispatchTimeMax, ListingDuration, ListingType, Quantity, SKU).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- Zod schema enforces all required Trading API item fields with correct types.
- Invalid or missing fields are rejected before reaching XML generation.
- Validation errors return clear, actionable messages to the MCP client.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
High
<!-- SECTION:PRIORITY:END -->
