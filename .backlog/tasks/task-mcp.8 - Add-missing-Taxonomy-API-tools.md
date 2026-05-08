---
id: TASK-MCP.8
title: Add missing Taxonomy API tools
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
Per Naji review: Add these missing MCP endpoints based on eBay Taxonomy API reference:

- `ebay_browse_categories` — Browse eBay category tree
- `ebay_get_category` — Get single category details by ID
- `ebay_search_categories` — Search categories by query
- `ebay_lookup_categories` — Lookup category by ID

These are NOT broken endpoints — they simply don't exist in the current MCP build. "Not Found" means the MCP endpoint doesn't exist, not that the eBay API endpoint is broken.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- All four tools registered and functional
- Zod schemas match eBay Taxonomy API reference
- Tools return structured category data usable for listing creation
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
Feature request — prioritize based on operational need
<!-- SECTION:PRIORITY:END -->
