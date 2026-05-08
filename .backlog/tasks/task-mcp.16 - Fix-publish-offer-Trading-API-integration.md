---
id: TASK-MCP.16
title: Fix publish_offer Trading API integration with XML transform
status: Done
assignee:
  - '@Bruno'
created_date: '2026-05-06'
updated_date: '2026-05-06'
labels: [bug, high, trading-api]
dependencies: [TASK-MCP.7, TASK-MCP.14]
parent_task_id: null
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
publish_offer handler now uses Trading API createListing() with proper XML transform instead of bypassing to Inventory API only.

Key mappings:
- Currency: read from pricingSummary
- Country: read from location (seoul-warehouse→KR)
- itemSpecifics: read from product.aspects
- images: read from product.imageUrls
- description: read from product.description

Fallback to Inventory API if Trading API fails.

Return policy: GS25/CU/7-ELEVEN convenience stores (no PO Box).

Full workflow documented in skill: ebay-publish-workflow.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- publish_offer uses Trading API createListing() as primary path
- XML transform correctly maps pricingSummary.Currency, location→Country, product.aspects→itemSpecifics
- Fallback to Inventory API if Trading API fails
- Draft offer flow verified working end-to-end
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
May 6, 2026 — Draft offer flow verified working. Trading API path primary with Inventory API fallback. All core tools live-tested: create_inventory_item, create_offer, publish_offer, upload_images, revise_listing, withdraw_offer, delete_offer.
<!-- SECTION:NOTES:END -->
