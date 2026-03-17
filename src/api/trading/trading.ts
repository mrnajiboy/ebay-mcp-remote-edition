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

  async getActiveListings(
    page = 1,
    entriesPerPage = 50
  ): Promise<ActiveListingsResult> {
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
    const pagination = activeList?.PaginationResult as
      | Record<string, unknown>
      | undefined;

    const listings: ListingSummary[] = items.map((item) => {
      const sellingStatus = item.SellingStatus as
        | Record<string, unknown>
        | undefined;
      const currentPrice = sellingStatus?.CurrentPrice as
        | Record<string, unknown>
        | number
        | undefined;
      const priceValue =
        typeof currentPrice === 'object' && currentPrice !== null
          ? Number(currentPrice['#text'] || 0)
          : Number(currentPrice || 0);

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

  async createListing(
    item: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return await this.client.execute('AddFixedPriceItem', { Item: item });
  }

  async reviseListing(
    itemId: string,
    fields: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    return await this.client.execute('ReviseFixedPriceItem', {
      Item: { ...fields, ItemID: itemId },
    });
  }

  async endListing(
    itemId: string,
    reason = 'NotAvailable'
  ): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    return await this.client.execute('EndFixedPriceItem', {
      ItemID: itemId,
      EndingReason: reason,
    });
  }

  async relistItem(
    itemId: string,
    modifications?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!itemId) throw new Error('itemId is required');

    return await this.client.execute('RelistFixedPriceItem', {
      Item: { ...modifications, ItemID: itemId },
    });
  }
}