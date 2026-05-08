---
id: TASK-MCP.4
title: Add dual endpoint support to ebay_upload_images
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-05'
updated_date: '2026-05-05'
labels: [bug, high]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`ebay_upload_images` currently only supports `create_image_from_url`. Per eBay Media API reference, it needs dual endpoint support:

1. `/image/create_image_from_file` — Accept file uploads directly (multipart/form-data)
2. `/image/create_image_from_url` — Accept public URLs (existing, but may need format fix)

Per Naji review: This is NOT an "Image Hosting API not enabled" issue. The API is functional — it just needs both endpoints with correct input formatting.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- `ebay_upload_images` accepts both file uploads and URL inputs
- `create_image_from_file` endpoint handles multipart file uploads per Media API reference
- `create_image_from_url` endpoint works with correct input format
- Tool returns hosted image URLs usable in listing payloads
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORITY:BEGIN -->
High
<!-- SECTION:PRIORITY:END -->
