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
        ActiveList: {
          ItemArray: null,
          PaginationResult: { TotalNumberOfEntries: 0 },
        },
      });

      const result = await api.getActiveListings();
      expect(result.listings).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should pass pagination params to execute', async () => {
      mockClient.execute.mockResolvedValue({
        Ack: 'Success',
        ActiveList: {
          ItemArray: null,
          PaginationResult: { TotalNumberOfEntries: 0 },
        },
      });

      await api.getActiveListings(2, 25);
      expect(mockClient.execute).toHaveBeenCalledWith('GetMyeBaySelling', {
        ActiveList: {
          Sort: 'TimeLeft',
          Pagination: { EntriesPerPage: 25, PageNumber: 2 },
        },
      });
    });
  });

  describe('getListing', () => {
    it('should call GetItem with itemId and return first item', async () => {
      mockClient.execute.mockResolvedValue({
        Ack: 'Success',
        Item: [{ ItemID: '12345', Title: 'Test', SKU: 'T1', Quantity: 5 }],
      });

      const result = await api.getListing('12345');
      expect(mockClient.execute).toHaveBeenCalledWith('GetItem', {
        ItemID: '12345',
        DetailLevel: 'ReturnAll',
      });
      expect(result.ItemID).toBe('12345');
    });

    it('should throw if itemId is missing', async () => {
      await expect(api.getListing('')).rejects.toThrow('itemId is required');
    });
  });

  describe('createListing', () => {
    it('should call AddFixedPriceItem', async () => {
      mockClient.execute.mockResolvedValue({ Ack: 'Success', ItemID: '99999' });

      const item = { Title: 'New Item', SKU: 'NEW', StartPrice: 9.99 };
      const result = await api.createListing(item);
      expect(mockClient.execute).toHaveBeenCalledWith('AddFixedPriceItem', {
        Item: item,
      });
      expect(result.ItemID).toBe('99999');
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

    it('should throw if itemId is missing', async () => {
      await expect(api.endListing('')).rejects.toThrow('itemId is required');
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

    it('should throw if itemId is missing', async () => {
      await expect(api.relistItem('')).rejects.toThrow('itemId is required');
    });
  });
});
