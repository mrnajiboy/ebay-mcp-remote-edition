# Trading API Support for ebay-mcp

## Problem

The ebay-mcp server only wraps eBay's REST Sell APIs. Listings created through eBay's UI (or the older Trading API) are invisible to the REST inventory endpoints. This means common seller operations — checking active listings, updating quantities, revising prices — don't work for most existing sellers.

## Solution

Add eBay Trading API support to ebay-mcp with six MCP tools for full fixed-price listing management.

## Architecture

### New Files

- `src/api/client-trading.ts` — XML request/response layer using `fast-xml-parser` (already a dependency)
- `src/api/trading/trading.ts` — `TradingApi` class following existing API module patterns
- `src/tools/definitions/trading.ts` — MCP tool definitions with Zod input schemas

### Modified Files

- `src/api/index.ts` — Register `TradingApi` in `EbaySellerApi`
- `src/tools/definitions/index.ts` — Export trading tools
- `src/tools/index.ts` — Add tool execution cases

### Auth

Reuses existing OAuth token via `X-EBAY-API-IAF-TOKEN` header. No new auth flow needed. The Trading API accepts the same user access token the REST APIs use.

### XML Handling

All XML serialization/deserialization happens in `client-trading.ts`. Tools receive and return clean JSON objects — no XML leaks into the MCP interface. Uses `fast-xml-parser` for both building and parsing XML.

### Trading API Endpoint

All calls POST to `https://api.ebay.com/ws/api.dll` with these headers:
- `X-EBAY-API-SITEID: 0` (US)
- `X-EBAY-API-COMPATIBILITY-LEVEL: 967`
- `X-EBAY-API-CALL-NAME: <call name>`
- `X-EBAY-API-IAF-TOKEN: <oauth token>`
- `Content-Type: text/xml`

## Tools

| Tool | Trading API Call | Purpose |
|------|-----------------|---------|
| `ebay_get_active_listings` | `GetMyeBaySelling` | List active listings with SKU, qty, price, watchers |
| `ebay_get_listing` | `GetItem` | Full details for a single listing by item ID |
| `ebay_create_listing` | `AddFixedPriceItem` | Create a new fixed-price listing |
| `ebay_revise_listing` | `ReviseFixedPriceItem` | Update any field (qty, price, title, description, etc.) |
| `ebay_end_listing` | `EndFixedPriceItem` | End/remove a listing |
| `ebay_relist_item` | `RelistFixedPriceItem` | Relist an ended listing |

All tools target fixed-price listings. Auction support is out of scope for now.

## Workflow

Build on fork `longrackslabs/ebay-mcp`, new branch `feat/trading-api`. PR to upstream `mrnajiboy/ebay-mcp` when proven.