import { describe, expect, it, vi } from 'vitest';
import { executeTool } from '../../../src/tools/index.js';

describe('trading tool handlers', () => {
  it('routes forceLocalProcessing URL uploads through the Sharp binary path', async () => {
    const api = {
      media: {
        createImageFromUrl: vi.fn(),
        createImageFromUrlWithLocalProcessing: vi
          .fn()
          .mockResolvedValue({ id: 'image-123', imageUrl: 'https://i.ebayimg.com/full.jpg' }),
        createImageFromFile: vi.fn(),
      },
    } as any;

    const result = await executeTool(api, 'ebay_upload_images', {
      imageUrls: ['https://supplier.example/image.jpg'],
      forceLocalProcessing: true,
    });

    expect(api.media.createImageFromUrlWithLocalProcessing).toHaveBeenCalledWith(
      'https://supplier.example/image.jpg',
      undefined
    );
    expect(api.media.createImageFromUrl).not.toHaveBeenCalled();
    expect(result).toEqual({
      uploaded: 1,
      failed: 0,
      results: [
        {
          success: true,
          id: 'image-123',
          imageUrl: 'https://i.ebayimg.com/full.jpg',
          uploadMode: 'binary-sharp',
        },
      ],
    });
  });

  it('falls back to Inventory API for inventory-backed revise listing price changes', async () => {
    const tradingError = new Error(
      'Inventory-based listing management is not currently supported by this tool. Please refer to the tool used to create this listing.'
    );
    const offer = {
      offerId: 'OFFER123',
      sku: 'SKU123',
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      pricingSummary: { price: { value: '9999.99', currency: 'USD' } },
    };
    const inventoryItem = {
      sku: 'SKU123',
      product: { title: 'Original title' },
      availability: { shipToLocationAvailability: { quantity: 1 } },
    };
    const api = {
      trading: {
        reviseListing: vi.fn().mockRejectedValue(tradingError),
        getListing: vi.fn().mockResolvedValue({ ItemID: 'ITEM123', SKU: 'SKU123' }),
      },
      inventory: {
        getOffers: vi.fn().mockResolvedValue({
          offers: [{ offerId: 'OFFER123', listing: { listingId: 'ITEM123' } }],
        }),
        getOffer: vi.fn().mockResolvedValue(offer),
        getInventoryItem: vi.fn().mockResolvedValue(inventoryItem),
        createOrReplaceInventoryItem: vi.fn().mockResolvedValue(undefined),
        updateOffer: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const result = await executeTool(api, 'ebay_revise_listing', {
      itemId: 'ITEM123',
      fields: { StartPrice: 14.99 },
    });

    expect(api.inventory.getOffers).toHaveBeenCalledWith('SKU123', undefined, 50);
    expect(api.inventory.updateOffer).toHaveBeenCalledWith(
      'OFFER123',
      expect.objectContaining({
        pricingSummary: { price: { value: '14.99', currency: 'USD' } },
      })
    );
    expect(api.inventory.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      Ack: 'Success',
      mode: 'inventory-api-fallback',
      ItemID: 'ITEM123',
      sku: 'SKU123',
      offerId: 'OFFER123',
      updatedFields: ['StartPrice'],
    });
  });

  it('falls back to Inventory API for inventory-backed revise listing title changes', async () => {
    const tradingError = new Error(
      'Inventory-based listing management is not currently supported by this tool. Please refer to the tool used to create this listing.'
    );
    const inventoryItem = {
      sku: 'SKU123',
      product: { title: 'Original title', brand: 'Hankuk Expo' },
      availability: { shipToLocationAvailability: { quantity: 1 } },
    };
    const api = {
      trading: {
        reviseListing: vi.fn().mockRejectedValue(tradingError),
        getListing: vi.fn().mockResolvedValue({ ItemID: 'ITEM123', SKU: 'SKU123' }),
      },
      inventory: {
        getOffers: vi.fn().mockResolvedValue({ offers: [{ offerId: 'OFFER123' }] }),
        getOffer: vi.fn().mockResolvedValue({ offerId: 'OFFER123', sku: 'SKU123' }),
        getInventoryItem: vi.fn().mockResolvedValue(inventoryItem),
        createOrReplaceInventoryItem: vi.fn().mockResolvedValue(undefined),
        updateOffer: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await executeTool(api, 'ebay_revise_listing', {
      itemId: 'ITEM123',
      fields: { Title: 'Updated title' },
    });

    expect(api.inventory.createOrReplaceInventoryItem).toHaveBeenCalledWith(
      'SKU123',
      expect.objectContaining({
        product: { title: 'Updated title', brand: 'Hankuk Expo' },
      })
    );
    expect(api.inventory.updateOffer).not.toHaveBeenCalled();
  });

  it('re-syncs only exact current PictureDetails URLs for inventory-backed listings', async () => {
    const pictureUrls = [
      'https://i.ebayimg.com/images/g/one/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/two/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/three/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/four/s-l1600.jpg',
    ];
    const inventoryItem = {
      sku: 'SKU123',
      product: {
        title: 'BABYMONSTER Album',
        brand: 'Hankuk Expo',
        imageUrls: ['https://i.ebayimg.com/images/g/old/s-l1600.jpg'],
      },
      availability: { shipToLocationAvailability: { quantity: 1 } },
    };
    const api = {
      trading: {
        reviseListing: vi.fn(),
        getListing: vi.fn().mockResolvedValue({
          ItemID: 'ITEM123',
          SKU: 'SKU123',
          SellingStatus: { ListingStatus: 'Active' },
          PictureDetails: { PictureURL: pictureUrls },
        }),
      },
      inventory: {
        getOffers: vi.fn().mockResolvedValue({
          offers: [{ offerId: 'OFFER123', listing: { listingId: 'ITEM123' } }],
        }),
        getOffer: vi.fn(),
        getInventoryItem: vi.fn().mockResolvedValue(inventoryItem),
        createOrReplaceInventoryItem: vi.fn().mockResolvedValue(undefined),
        updateOffer: vi.fn(),
      },
    } as any;

    const result = await executeTool(api, 'ebay_revise_listing', {
      itemId: 'ITEM123',
      fields: { PictureDetails: { PictureURL: pictureUrls } },
    });

    expect(api.trading.reviseListing).not.toHaveBeenCalled();
    expect(api.inventory.getOffers).toHaveBeenCalledWith('SKU123', undefined, 50);
    expect(api.inventory.createOrReplaceInventoryItem).toHaveBeenCalledWith('SKU123', {
      sku: 'SKU123',
      product: {
        title: 'BABYMONSTER Album',
        brand: 'Hankuk Expo',
        imageUrls: pictureUrls,
      },
      availability: { shipToLocationAvailability: { quantity: 1 } },
    });
    expect(api.inventory.getOffer).not.toHaveBeenCalled();
    expect(api.inventory.updateOffer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      Ack: 'Success',
      mode: 'inventory-api-picture-details-resync',
      updatedFields: ['PictureDetails'],
      imageUrls: pictureUrls,
    });
  });

  it('refuses PictureDetails URLs that do not exactly match the active listing', async () => {
    const activeUrls = ['https://i.ebayimg.com/images/g/one/s-l1600.jpg'];
    const api = {
      trading: {
        reviseListing: vi.fn(),
        getListing: vi.fn().mockResolvedValue({
          ItemID: 'ITEM123',
          SKU: 'SKU123',
          SellingStatus: { ListingStatus: 'Active' },
          PictureDetails: { PictureURL: activeUrls },
        }),
      },
      inventory: {
        getInventoryItem: vi.fn(),
        createOrReplaceInventoryItem: vi.fn(),
      },
    } as any;

    await expect(
      executeTool(api, 'ebay_revise_listing', {
        itemId: 'ITEM123',
        fields: {
          PictureDetails: { PictureURL: ['https://i.ebayimg.com/images/g/other/s-l1600.jpg'] },
        },
      })
    ).rejects.toThrow('must exactly match the active listing URLs');

    expect(api.trading.reviseListing).not.toHaveBeenCalled();
    expect(api.inventory.getInventoryItem).not.toHaveBeenCalled();
    expect(api.inventory.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });

  it('refuses a PictureDetails revision combined with another field', async () => {
    const pictureUrls = ['https://i.ebayimg.com/images/g/one/s-l1600.jpg'];
    const api = {
      trading: {
        reviseListing: vi.fn(),
        getListing: vi.fn().mockResolvedValue({
          ItemID: 'ITEM123',
          SKU: 'SKU123',
          SellingStatus: { ListingStatus: 'Active' },
          PictureDetails: { PictureURL: pictureUrls },
        }),
      },
      inventory: {
        getInventoryItem: vi.fn(),
        createOrReplaceInventoryItem: vi.fn(),
      },
    } as any;

    await expect(
      executeTool(api, 'ebay_revise_listing', {
        itemId: 'ITEM123',
        fields: { PictureDetails: { PictureURL: pictureUrls }, Title: 'Do not update' },
      })
    ).rejects.toThrow('only permits a complete PictureDetails revision with no other fields');

    expect(api.trading.reviseListing).not.toHaveBeenCalled();
    expect(api.inventory.getInventoryItem).not.toHaveBeenCalled();
    expect(api.inventory.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });

  it('refuses PictureDetails re-sync for a non-active listing before any inventory write', async () => {
    const pictureUrls = ['https://i.ebayimg.com/images/g/one/s-l1600.jpg'];
    const api = {
      trading: {
        reviseListing: vi.fn(),
        getListing: vi.fn().mockResolvedValue({
          ItemID: 'ITEM123',
          SKU: 'SKU123',
          SellingStatus: { ListingStatus: 'Ended' },
          PictureDetails: { PictureURL: pictureUrls },
        }),
      },
      inventory: {
        getOffers: vi.fn(),
        getInventoryItem: vi.fn(),
        createOrReplaceInventoryItem: vi.fn(),
      },
    } as any;

    await expect(
      executeTool(api, 'ebay_revise_listing', {
        itemId: 'ITEM123',
        fields: { PictureDetails: { PictureURL: pictureUrls } },
      })
    ).rejects.toThrow('requires an active listing');

    expect(api.trading.reviseListing).not.toHaveBeenCalled();
    expect(api.inventory.getOffers).not.toHaveBeenCalled();
    expect(api.inventory.getInventoryItem).not.toHaveBeenCalled();
    expect(api.inventory.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });

  it('refuses PictureDetails re-sync when no matching inventory-backed offer exists', async () => {
    const pictureUrls = ['https://i.ebayimg.com/images/g/one/s-l1600.jpg'];
    const api = {
      trading: {
        reviseListing: vi.fn(),
        getListing: vi.fn().mockResolvedValue({
          ItemID: 'ITEM123',
          SKU: 'SKU123',
          SellingStatus: { ListingStatus: 'Active' },
          PictureDetails: { PictureURL: pictureUrls },
        }),
      },
      inventory: {
        getOffers: vi.fn().mockResolvedValue({ offers: [] }),
        getInventoryItem: vi.fn(),
        createOrReplaceInventoryItem: vi.fn(),
      },
    } as any;

    await expect(
      executeTool(api, 'ebay_revise_listing', {
        itemId: 'ITEM123',
        fields: { PictureDetails: { PictureURL: pictureUrls } },
      })
    ).rejects.toThrow('could not confirm inventory-backed offer');

    expect(api.trading.reviseListing).not.toHaveBeenCalled();
    expect(api.inventory.getInventoryItem).not.toHaveBeenCalled();
    expect(api.inventory.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
});
