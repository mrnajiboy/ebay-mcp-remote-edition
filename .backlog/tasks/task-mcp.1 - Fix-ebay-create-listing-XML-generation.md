---
id: TASK-MCP.1
title: Fix ebay_create_listing XML generation
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-03'
updated_date: '2026-05-05'
labels: [bug, critical]
dependencies: [TASK-MCP.1.1, TASK-MCP.1.2]
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tool passes JSON directly to fast-xml-parser which generates invalid XML for eBay Trading API. Flat fields fail MCP validation, nested objects generate malformed XML.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_create_listing` successfully creates a listing on eBay with proper XML structure.
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Critical
<!-- SECTION:PRIORITY:END -->
