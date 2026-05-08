---
id: TASK-MCP.14
title: Fix publish_offer listingPolicies requirement and upload_images response parsing
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-06'
updated_date: '2026-05-06'
labels: [bug, high]
dependencies: []
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Smoke tests on fresh deploy (commit e500170) revealed two bugs:

### Bug 1: `publish_offer` fails when offer missing listingPolicies
Offer `161012007011` (SKU: TEST-CRAZY-HE-001) failed publish with:
`"No <Item.Country> exists or <Item.Country> is specified as an empty tag in the request."`

Root cause: Offer was created without `listingPolicies` (paymentPolicyId, returnPolicyId, fulfillmentPolicyId). The pre-publish handler (lines 1102-1169 of `src/tools/index.ts`) adds defaults for `categoryId` and `merchantLocationKey` but does NOT add `listingPolicies`. Compare with published offer `161612713011` which has all three policy IDs.

**Requirement for future listings:** Offers must have `listingPolicies` with valid policy IDs before publishing. The pre-publish handler should either:
- Fetch and inject default policies from account, OR
- Return a clear error message telling the user which policies are missing

### Bug 2: `upload_images` createImageFromUrl response parsing broken
All test URLs fail with `"No image ID returned from createImageFromUrl endpoint"`:
- `https://picsum.photos/500/500` → error
- `https://i.imgur.com/...` → error  
- `https://i.ebayimg.com/...` → error

Root cause: `src/api/media/media.ts` line 76-82 expects `data.id` at top level of response. The eBay Media API `createImageFromUrl` endpoint returns a response where the image ID is NOT at `data.id`. The actual response structure needs investigation (likely `data.image.id` or `data.images[0].id`).

**Code location:** `src/api/media/media.ts` lines 75-82.
**Handler:** `ebay_upload_images` in `src/tools/index.ts` calls `api.media.createImageFromUrl()`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
### publish_offer:
- Pre-publish handler checks for `listingPolicies` and adds defaults (or returns actionable error)
- Offer with only `sku`, `marketplaceId`, `format`, `pricingSummary` can still be published
- Pre-existing offers without policies can be published by injecting defaults

### upload_images:
- `createImageFromUrl` correctly parses image ID from eBay API response
- At least one test URL successfully returns an eBay-hosted image URL
- Tool returns `{"uploaded": 1, "failed": 0, "results": [...]}` on success
<!-- SECTION:ACCEPTANCE:END -->

## Priority

<!-- SECTION:PRIORiy:BEGIN -->
High — both block live listing creation workflow
<!-- SECTION:PRIORiy:END -->

## Notes for Skill Writing

### publish_offer Requirements
- Offer MUST have `listingPolicies` with valid `paymentPolicyId`, `returnPolicyId`, `fulfillmentPolicyId` before publishing
- Pre-publish handler should auto-inject defaults or return clear error
- Default policies (from existing published listings): payment=259198675013, return=259198703013, fulfillment=259198453013
- `categoryId` and `merchantLocationKey` defaults already handled

**⚠️ LEGACY WORKAROUND: Policy IDs are HARDCODED in handler (src/tools/index.ts).** This works for single-account (Hankuk Expo) but MUST be moved to KV store (Upstash Redis or Coolify env vars) before multi-account support. Hardcoded values:
```typescript
const defaultPolicies = {
  paymentPolicyId: '259198675013',
  returnPolicyId: '259198703013',
  fulfillmentPolicyId: '259198453013',
};
```
**TODO:** Create `getAccountPolicies()` function that fetches from Redis key `account:{userId}:policies` or env var `EBAY_DEFAULT_POLICIES` (JSON string). Fall back to hardcoded only if not found.

### upload_images Requirements  
- `createImageFromUrl` response structure: need to investigate actual eBay API response format
- `createImageFromFile` (multipart) should still work independently
- Image dimensions: 500px minimum on longest side
- Supported formats: JPG, GIF, PNG, BMP, TIFF, AVIF, HEIC, WEBP
