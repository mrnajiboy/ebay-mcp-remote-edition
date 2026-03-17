# Trading API Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add eBay Trading API support to ebay-mcp with six MCP tools for full fixed-price listing management.

**Architecture:** New `TradingApiClient` handles XML serialization/deserialization via `fast-xml-parser` (already a dependency). New `TradingApi` class exposes methods matching existing API module patterns. Six new MCP tools wire into the existing tool registry.

**Tech Stack:** TypeScript, fast-xml-parser, axios, zod, vitest, nock

---

### Task 1: Create Trading API XML Client

**Files:**
- Create: `src/api/client-trading.ts`
- Test: `tests/unit/api/client-trading.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/api/client-trading.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import nock from 'nock';
import { TradingApiClient } from '@/api/client-trading.js';

const mockOAuthClient = {
  hasUserTokens: vi.fn(),
  getAccessToken: vi.fn(),
  setUserTokens: vi.fn(),
  initialize: vi.fn(),
  getTokenInfo: vi.fn(),
  isAuthenticated: vi.fn(),
};

vi.mock('@/auth/oauth.js', () => ({
  EbayOAuthClient: vi.fn(function (this: unknown) {
    return mockOAuthClient;
  }),
}));

describe('TradingApiClient', () => {
  let client: TradingApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    nock.disableNetConnect();
    mockOAuthClient.getAccessToken.mockResolvedValue('mock_token');

    client = new TradingApiClient({
      clientId: 'test_id',
      clientSecret: 'test_secret',
      environment: 'production',
      redirectUri: 'https://localhost/callback',
    });
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('should send XML request with correct headers', async () => {
    const scope = nock('https://api.ebay.com')
      .post('/ws/api.dll')
      .matchHeader('X-EBAY-API-CALL-NAME', 'GetMyeBaySelling')
      .matchHeader('X-EBAY-API-SITEID', '0')
      .matchHeader('X-EBAY-API-COMPATIBILITY-LEVEL', '967')
      .matchHeader('X-EBAY-API-IAF-TOKEN', 'mock_token')
      .matchHeader('Content-Type', 'text/xml')
      .reply(200, `<?xml version="1.0" encoding="utf-8"?>
        <GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
        </GetMyeBaySellingResponse>`);

    const result = await client.execute('GetMyeBaySelling', {});
    expect(result.Ack).toBe('Success');
    scope.done();
  });

  it('should build XML request body from params', async () => {
    const scope = nock('https://api.ebay.com')
      .post('/ws/api.dll', (body: string) => {
        return body.includes('<ItemID>12345</ItemID>');
      })
      .reply(200, `<?xml version="1.0" encoding="utf-8"?>
        <GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Success</Ack>
          <Item><ItemID>12345</ItemID></Item>
        </GetItemResponse>`);

    const result = await client.execute('GetItem', { ItemID: '12345' });
    expect(result.Ack).toBe('Success');
    scope.done();
  });

  it('should throw on eBay error response', async () => {
    nock('https://api.ebay.com')
      .post('/ws/api.dll')
      .reply(200, `<?xml version="1.0" encoding="utf-8"?>
        <GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
          <Ack>Failure</Ack>
          <Errors>
            <ShortMessage>Invalid item ID</ShortMessage>
            <LongMessage>The item ID 99999 is invalid.</LongMessage>
            <SeverityCode>Error</SeverityCode>
          </Errors>
        </GetItemResponse>`);

    await expect(client.execute('GetItem', { ItemID: '99999' }))
      .rejects.toThrow('Invalid item ID');
  });

  it('should use sandbox URL for sandbox environment', () => {
    const sandboxClient = new TradingApiClient({
      clientId: 'test_id',
      clientSecret: 'test_secret',
      environment: 'sandbox',
      redirectUri: 'https://localhost/callback',
    });
    expect(sandboxClient.getBaseUrl()).toBe('https://api.sandbox.ebay.com');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api/client-trading.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/api/client-trading.ts
import axios from 'axios';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { EbayOAuthClient } from '@/auth/oauth.js';
import type { EbayConfig } from '@/types/ebay.js';
import { apiLogger } from '@/utils/logger.js';

const COMPAT_LEVEL = '967';
const SITE_ID = '0';

export class TradingApiClient {
  private authClient: EbayOAuthClient;
  private baseUrl: string;
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor(config: EbayConfig) {
    this.authClient = new EbayOAuthClient(config);
    this.baseUrl = config.environment === 'sandbox'
      ? 'https://api.sandbox.ebay.com'
      : 'https://api.ebay.com';

    this.parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      parseTagValue: true,
      isArray: (name) => {
        // Tags that should always be arrays even with single elements
        const arrayTags = ['Item', 'Errors', 'Error', 'NameValueList', 'Value',
          'ShippingServiceOptions', 'InternationalShippingServiceOption',
          'PaymentMethods', 'PictureURL', 'CompatibilityList'];
        return arrayTags.includes(name);
      },
    });

    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async execute(callName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.authClient.getAccessToken();

    const requestTag = `${callName}Request`;
    const responseTag = `${callName}Response`;

    const xmlObj: Record<string, unknown> = {};
    xmlObj[requestTag] = {
      '@_xmlns': 'urn:ebay:apis:eBLBaseComponents',
      ...params,
    };

    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>\n${this.builder.build(xmlObj)}`;

    apiLogger.debug(`Trading API ${callName}`, { xmlBody });

    const response = await axios.post(`${this.baseUrl}/ws/api.dll`, xmlBody, {
      headers: {
        'X-EBAY-API-SITEID': SITE_ID,
        'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      timeout: 30000,
    });

    const parsed = this.parser.parse(response.data);
    const result = parsed[responseTag] || parsed;

    // Check for eBay errors
    if (result.Ack === 'Failure') {
      const errors = result.Errors;
      const firstError = Array.isArray(errors) ? errors[0] : errors;
      const message = firstError?.ShortMessage || firstError?.LongMessage || 'Unknown Trading API error';
      throw new Error(message);
    }

    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api/client-trading.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/client-trading.ts tests/unit/api/client-trading.test.ts
git commit -m "feat: add Trading API XML client"
```

---

### Task 2: Create TradingApi Class

**Files:**
- Create: `src/api/trading/trading.ts`
- Test: `tests/unit/api/trading.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/api/trading.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TradingApi } from '@/api/trading/trading.js';
import type { TradingApiClient } from '@/api/client-trading.js';

describe('TradingApi', () => {
  let api: TradingApi;
  let mockClient: { execute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { execute: vi.fn() };
    api = new TradingApi(mockClient as unknown as TradingApiClient);
  });

  describe('getActiveListings', () => {
    it('should call GetMyeBaySelling and return normalized listings', async () => {
      mockClient.execute.mockResolvedValue({
        Ack: 'Success',
        ActiveList: {
          ItemArray: {
            Item: [
              {
                ItemID: '167382780779',
                Title: 'Bambu Lab 0.2mm Nozzle',
                SKU: 'NZ-2MM',
                Quantity: 10,
                QuantityAvailable: 4,
                SellingStatus: { CurrentPrice: { '#text': 12.99 } },
                WatchCount: 3,
                ListingType: 'FixedPriceItem',
              },
            ],
          },
          PaginationResult: { TotalNumberOfEntries: 1, TotalNumberOfPages: 1 },
        },
      });

      const result = await api.getActiveListings();
      expect(result.listings).toHaveLength(1);
      expect(result.listings[0]).toEqual({
        itemId: '167382780779',
        title: 'Bambu Lab 0.2mm Nozzle',
        sku: 'NZ-2MM',
        quantity: 10,
        quantityAvailable: 4,
        currentPrice: 12.99,
        watchCount: 3,
        listingType: 'FixedPriceItem',
      });
      expect(result.total).toBe(1);
    });

    it('should handle empty listings', async () => {
      mockClient.execute.mockResolvedValue({
        Ack: 'Success',
        ActiveList: { ItemArray: null, PaginationResult: { TotalNumberOfEntries: 0 } },
      });

      const result = await api.getActiveListings();
      expect(result.listings).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('getListing', () => {
    it('should call GetItem with itemId', async () => {
      mockClient.execute.mockResolvedValue({
        Ack: 'Success',
        Item: [{ ItemID: '12345', Title: 'Test', SKU: 'T1', Quantity: 5 }],
      });

      const result = await api.getListing('12345');
      expect(mockClient.execute).toHaveBeenCalledWith('GetItem', expect.objectContaining({
        ItemID: '12345',
      }));
      expect(result.ItemID).toBe('12345');
    });

    it('should throw if itemId is missing', async () => {
      await expect(api.getListing('')).rejects.toThrow('itemId is required');
    });
  });

  describe('reviseListing', () => {
    it('should call ReviseFixedPriceItem with fields', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success', ItemID: '12345' });

      const result = await api.reviseListing('12345', { Quantity: 10 });
      expect(mockClient.execute).toHaveBeenCalledWith('ReviseFixedPriceItem', {
        Item: { ItemID: '12345', Quantity: 10 },
      });
      expect(result.ItemID).toBe('12345');
    });

    it('should throw if itemId is missing', async () => {
      await expect(api.reviseListing('', {})).rejects.toThrow('itemId is required');
    });
  });

  describe('createListing', () => {
    it('should call AddFixedPriceItem', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success', ItemID: '99999' });

      const item = { Title: 'New Item', SKU: 'NEW', StartPrice: 9.99 };
      const result = await api.createListing(item);
      expect(mockClient.execute).toHaveBeenCalledWith('AddFixedPriceItem', { Item: item });
      expect(result.ItemID).toBe('99999');
    });
  });

  describe('endListing', () => {
    it('should call EndFixedPriceItem', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success' });

      await api.endListing('12345', 'NotAvailable');
      expect(mockClient.execute).toHaveBeenCalledWith('EndFixedPriceItem', {
        ItemID: '12345',
        EndingReason: 'NotAvailable',
      });
    });

    it('should default reason to NotAvailable', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success' });

      await api.endListing('12345');
      expect(mockClient.execute).toHaveBeenCalledWith('EndFixedPriceItem', {
        ItemID: '12345',
        EndingReason: 'NotAvailable',
      });
    });
  });

  describe('relistItem', () => {
    it('should call RelistFixedPriceItem', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success', ItemID: '12345' });

      const result = await api.relistItem('12345');
      expect(mockClient.execute).toHaveBeenCalledWith('RelistFixedPriceItem', {
        Item: { ItemID: '12345' },
      });
      expect(result.ItemID).toBe('12345');
    });

    it('should pass optional modifications', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success', ItemID: '12345' });

      await api.relistItem('12345', { Quantity: 20, StartPrice: 15.99 });
      expect(mockClient.execute).toHaveBeenCalledWith('RelistFixedPriceItem', {
        Item: { ItemID: '12345', Quantity: 20, StartPrice: 15.99 },
      });
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api/trading.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/api/trading/trading.ts
import type { TradingApiClient } from '@/api/client-trading.js';

interface ListingSummary {
  itemId: string;
  title: string;
  sku: string;
  quantity: number;
  quantityAvailable: number;
  currentPrice: number;
  watchCount: number;
  listingType: string;
}

interface ActiveListingsResult {
  listings: ListingSummary[];
  total: number;
  totalPages: number;
}

export class TradingApi {
  constructor(private client: TradingApiClient) {}

  async getActiveListings(page = 1, entriesPerPage = 50): Promise<ActiveListingsResult> {
    const result = await this.client.execute('GetMyeBaySelling', {
      ActiveList: {
        Sort: 'TimeLeft',
        Pagination: {
          EntriesPerPage: entriesPerPage,
          PageNumber: page,
        },
      },
    });

    const activeList = result.ActiveList as Record<string, unknown> | undefined;
    const itemArray = activeList?.ItemArray as Record<string, unknown> | null;
    const items = (itemArray?.Item as Record<string, unknown>[]) || [];
    const pagination = activeList?.PaginationResult as Record<string, unknown> | undefined;

    const listings: ListingSummary[] = items.map((item) => {
      const sellingStatus = item.SellingStatus as Record<string, unknown> | undefined;
      const currentPrice = sellingStatus?.CurrentPrice as Record<string, unknown> | number | undefined;
      const priceValue = typeof currentPrice === 'object' && currentPrice !== null
        ? (currentPrice['#text'] as number)
        : (currentPrice as number) || 0;

      return {
        itemId: String(item.ItemID || ''),
        title: String(item.Title || ''),
        sku: String(item.SKU || ''),
        quantity: Number(item.Quantity || 0),
        quantityAvailable: Number(item.QuantityAvailable || 0),
        currentPrice: priceValue,
        watchCount: Number(item.WatchCount || 0),
        listingType: String(item.ListingType || ''),
      };
    });

    return {
      listings,
      total: Number(pagination?.TotalNumberOfEntries || 0),
      totalPages: Number(pagination?.TotalNumberOfPages || 0),
    };
  }

  async getListing(itemId: string): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    const result = await this.client.execute('GetItem', {
      ItemID: itemId,
      DetailLevel: 'ReturnAll',
    });

    const items = result.Item as Record<string, unknown>[];
    return items?.[0] || result;
  }

  async createListing(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.client.execute('AddFixedPriceItem', { Item: item });
  }

  async reviseListing(itemId: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    return await this.client.execute('ReviseFixedPriceItem', {
      Item: { ItemID: itemId, ...fields },
    });
  }

  async endListing(itemId: string, reason = 'NotAvailable'): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    return await this.client.execute('EndFixedPriceItem', {
      ItemID: itemId,
      EndingReason: reason,
    });
  }

  async relistItem(itemId: string, modifications?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    return await this.client.execute('RelistFixedPriceItem', {
      Item: { ItemID: itemId, ...modifications },
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api/trading.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/trading/trading.ts tests/unit/api/trading.test.ts
git commit -m "feat: add TradingApi class with listing management methods"
```

---

### Task 3: Register TradingApi in EbaySellerApi

**Files:**
- Modify: `src/api/index.ts`

**Step 1: Add import and property**

Add to imports:
```typescript
import { TradingApi } from '@/api/trading/trading.js';
import { TradingApiClient } from '@/api/client-trading.js';
```

Add public property:
```typescript
public trading: TradingApi;
```

Add to constructor:
```typescript
const tradingClient = new TradingApiClient(config);
this.trading = new TradingApi(tradingClient);
```

Add to exports:
```typescript
export * from '@/api/trading/trading.js';
export * from '@/api/client-trading.js';
```

**Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests still pass

**Step 3: Commit**

```bash
git add src/api/index.ts
git commit -m "feat: register TradingApi in EbaySellerApi"
```

---

### Task 4: Create MCP Tool Definitions

**Files:**
- Create: `src/tools/definitions/trading.ts`

**Step 1: Write tool definitions**

```typescript
// src/tools/definitions/trading.ts
import { z } from 'zod';
import type { ToolDefinition } from './account.js';

export const tradingTools: ToolDefinition[] = [
  {
    name: 'ebay_get_active_listings',
    description:
      'Get all active fixed-price listings with SKU, quantity, price, and watch count.\n\nUses the Trading API (GetMyeBaySelling). Returns listings created via any method (UI, Trading API, or REST API).\n\nRequired: User OAuth token.',
    inputSchema: {
      page: z.number().optional().describe('Page number (default 1)'),
      entriesPerPage: z.number().optional().describe('Items per page, max 200 (default 50)'),
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ebay_get_listing',
    description:
      'Get full details for a single listing by item ID.\n\nUses the Trading API (GetItem). Returns all listing fields including description, specifics, shipping, and images.\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID (e.g., "167382780779")'),
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ebay_create_listing',
    description:
      'Create a new fixed-price listing.\n\nUses the Trading API (AddFixedPriceItem). Requires complete item details.\n\nRequired: User OAuth token.',
    inputSchema: {
      item: z.record(z.unknown()).describe('Item details object. Required fields: Title, PrimaryCategory.CategoryID, StartPrice, ConditionID, Country, Currency, DispatchTimeMax, ListingDuration, ListingType ("FixedPriceItem"), Quantity, SKU.'),
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ebay_revise_listing',
    description:
      'Revise an existing fixed-price listing. Update quantity, price, title, description, or any other field.\n\nUses the Trading API (ReviseFixedPriceItem). Only send the fields you want to change.\n\nExamples:\n- Update quantity: { "Quantity": 10 }\n- Update price: { "StartPrice": 14.99 }\n- Update title: { "Title": "New Title" }\n- Multiple fields: { "Quantity": 10, "StartPrice": 14.99 }\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID to revise'),
      fields: z.record(z.unknown()).describe('Fields to update (e.g., { "Quantity": 10, "StartPrice": 14.99 })'),
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ebay_end_listing',
    description:
      'End/remove an active fixed-price listing.\n\nUses the Trading API (EndFixedPriceItem).\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID to end'),
      reason: z.enum(['NotAvailable', 'Incorrect', 'LostOrBroken', 'OtherListingError', 'SellToHighBidder'])
        .optional()
        .describe('Reason for ending (default: NotAvailable)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'ebay_relist_item',
    description:
      'Relist an ended fixed-price listing, optionally with modifications.\n\nUses the Trading API (RelistFixedPriceItem).\n\nRequired: User OAuth token.',
    inputSchema: {
      itemId: z.string().describe('The eBay item ID to relist'),
      modifications: z.record(z.unknown()).optional().describe('Optional fields to change when relisting (e.g., { "Quantity": 20 })'),
    },
    annotations: { readOnlyHint: false },
  },
];
```

**Step 2: Commit**

```bash
git add src/tools/definitions/trading.ts
git commit -m "feat: add Trading API MCP tool definitions"
```

---

### Task 5: Wire Tools Into Registry

**Files:**
- Modify: `src/tools/definitions/index.ts`
- Modify: `src/tools/index.ts`

**Step 1: Add trading tools to definitions index**

In `src/tools/definitions/index.ts`, add import:
```typescript
import { tradingTools } from './trading.js';
```

Add to exports:
```typescript
export { tradingTools };
```

Add to `allTools` array:
```typescript
...tradingTools,
```

**Step 2: Add trading tools to getToolDefinitions and executeTool**

In `src/tools/index.ts`, add import:
```typescript
import { tradingTools } from '@/tools/definitions/index.js';
```

Add `...tradingTools` to the `getToolDefinitions()` return array.

Add cases to the `executeTool` switch statement (before the `default` case):

```typescript
// Trading API - Listing Management
case 'ebay_get_active_listings':
  return await api.trading.getActiveListings(
    args.page as number | undefined,
    args.entriesPerPage as number | undefined,
  );
case 'ebay_get_listing':
  return await api.trading.getListing(args.itemId as string);
case 'ebay_create_listing':
  return await api.trading.createListing(args.item as Record<string, unknown>);
case 'ebay_revise_listing':
  return await api.trading.reviseListing(
    args.itemId as string,
    args.fields as Record<string, unknown>,
  );
case 'ebay_end_listing':
  return await api.trading.endListing(
    args.itemId as string,
    args.reason as string | undefined,
  );
case 'ebay_relist_item':
  return await api.trading.relistItem(
    args.itemId as string,
    args.modifications as Record<string, unknown> | undefined,
  );
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

**Step 4: Commit**

```bash
git add src/tools/definitions/index.ts src/tools/index.ts
git commit -m "feat: wire Trading API tools into MCP tool registry"
```

---

### Task 6: Build and Smoke Test

**Step 1: Build**

Run: `npm run build`
Expected: Clean build, no type errors

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Smoke test against live eBay**

```bash
cd /Users/gpeden/src/ebay-mcp && node -e "
const dotenv = require('dotenv');
dotenv.config();
// ... refresh token, then test getActiveListings via TradingApi
"
```

Verify: Returns the 4 active nozzle listings with correct SKUs and quantities.

**Step 4: Commit any fixes, then push**

```bash
git push -u origin feat/trading-api
```

---

### Task 7: Create PR to Upstream

Create PR from `longrackslabs/ebay-mcp:feat/trading-api` to `mrnajiboy/ebay-mcp:main`.

Include the .env quoting fix from the earlier branch too, or note it as a dependency.