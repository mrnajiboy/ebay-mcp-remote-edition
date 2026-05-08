---
id: TASK-MCP.15
title: Fix createImageFromUrl to process images with sharp before upload
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-06'
updated_date: '2026-05-06'
labels: [bug, critical]
dependencies: []
parent_task_id: null
---

## Problem

`createImageFromUrl` in `src/api/media/media.ts` passed the source image URL directly to eBay's `create_image_from_url` endpoint for server-side download. This meant images smaller than 500px (eBay's minimum) were uploaded unchanged and rejected by `publish_offer` with error: "please upload high-resolution photos that are at least 500 pixels on the longest side".

The `processImageForUpload()` function (sharp library) and `uploadProcessedImage()` were already built but never wired into the URL upload path.

## Solution

Rewrote `createImageFromUrl` to:
1. **Download** image from source URL (axios, max 10MB)
2. **Process** via `processImageForUpload()` (sharp: enlarges if <500px, converts to JPEG @90%)
3. **Upload** via `uploadProcessedImage()` (multipart/form-data)

## Files Changed

- `src/api/media/media.ts` — `createImageFromUrl()` rewritten, `processImageForUpload` imported, JSDoc updated

## Testing

- LINT: 0 errors ✅
- BUILD: tsc + tsc-alias passed ✅
- TEST: 1061/1061 passed ✅

## Notes

- Images <500px on longest side are automatically enlarged to minimum 500px using sharp's `resize()` with `withoutEnlargement: false`
- All images converted to JPEG at 90% quality before upload
- Images >4800px still downsized
- `sell.inventory` scope sufficient — no `commerce.media` needed
