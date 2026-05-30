import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EbaySellerApi } from '../../../src/api/index.js';
import type { ValidationRunRequest } from '../../../src/validation/types.js';

const getWithFullUrlMock = vi.fn();

function createSellerApi(): EbaySellerApi {
  return {
    getAuthClient: () => ({
      getConfig: () => ({ environment: 'production' }),
      getWithFullUrl: getWithFullUrlMock,
    }),
  } as unknown as EbaySellerApi;
}

function createRequest(
  queryContext: ValidationRunRequest['validation']['queryContext']
): ValidationRunRequest {
  return {
    validationId: 'val_123',
    runType: 'manual',
    cadence: 'Off',
    timestamp: '2026-05-29T00:00:00.000Z',
    item: {
      recordId: 'rec_123',
      name: 'LE SSERAFIM Acrylic Stand',
      variation: [],
      itemType: ['Goods'],
      releaseType: [],
      releaseDate: null,
      releasePeriod: [],
      availability: [],
      wholesalePrice: null,
      supplierNames: [],
      canonicalArtists: ['LE SSERAFIM'],
      relatedAlbums: [],
    },
    validation: {
      validationType: 'Item Validation',
      buyDecision: 'Watching',
      automationStatus: 'Manual',
      autoCheckEnabled: true,
      dDay: null,
      artistTier: 'A',
      initialBudget: null,
      reserveBudget: null,
      queryContext,
      currentMetrics: {
        avgWatchersPerListing: null,
        preOrderListingsCount: null,
        twitterTrending: false,
        youtubeViews24hMillions: null,
        redditPostsCount7d: null,
        marketPriceUsd: null,
        avgShippingCostUsd: null,
        competitionLevel: null,
        marketPriceTrend: 'Stable',
        day1Sold: null,
        day2Sold: null,
        day3Sold: null,
        day4Sold: null,
        day5Sold: null,
        daysTracked: null,
      },
    },
  };
}

describe('getEbayValidationSignals()', () => {
  beforeEach(() => {
    vi.resetModules();
    getWithFullUrlMock.mockReset();
  });

  it('suppresses broad Browse totals when sampled titles do not prove artist/item relevance', async () => {
    const { getEbayValidationSignals } = await import('../../../src/validation/providers/ebay.js');

    getWithFullUrlMock.mockResolvedValueOnce({
      total: 712222,
      itemSummaries: [
        {
          title: 'Generic acrylic stand display base',
          price: { value: '9.00' },
          shippingOptions: [{ shippingCost: { value: '0.00' } }],
        },
        {
          title: 'Anime acrylic stand random character',
          price: { value: '12.00' },
          shippingOptions: [{ shippingCost: { value: '1.00' } }],
        },
      ],
    });

    const result = await getEbayValidationSignals(
      createSellerApi(),
      createRequest({
        directQueryActive: true,
        queryScope: 'Direct Query',
        resolvedSearchArtist: 'LE SSERAFIM',
        resolvedSearchItem: 'acrylic stand',
        resolvedSearchQuery: 'acrylic stand',
      })
    );

    expect(result.selectedQuery).toBe('acrylic stand');
    expect(result.preOrderListingsCount).toBeNull();
    expect(result.competitionLevel).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.queryDiagnostics?.[0]).toEqual(
      expect.objectContaining({
        rawTotalListings: 712222,
        totalListings: null,
        rawItemSummaryCount: 2,
        itemSummaryCount: 0,
        countGuard: expect.objectContaining({ applied: true, titleMatchedCount: 0 }),
      })
    );
  });

  it('uses artist/item-matched sampled rows instead of broad Browse totals', async () => {
    const { getEbayValidationSignals } = await import('../../../src/validation/providers/ebay.js');

    getWithFullUrlMock.mockResolvedValueOnce({
      total: 705693,
      itemSummaries: [
        {
          title: 'LE SSERAFIM acrylic stand official merch',
          price: { value: '20.00' },
          shippingOptions: [{ shippingCost: { value: '3.00' } }],
        },
        {
          title: 'LE SSERAFIM EASY acrylic stand K-pop goods',
          price: { value: '24.00' },
          shippingOptions: [{ shippingCost: { value: '5.00' } }],
        },
        {
          title: 'Generic acrylic stand display base',
          price: { value: '9.00' },
          shippingOptions: [{ shippingCost: { value: '0.00' } }],
        },
      ],
    });

    const result = await getEbayValidationSignals(
      createSellerApi(),
      createRequest({
        directQueryActive: true,
        queryScope: 'Direct Query',
        resolvedSearchArtist: 'LE SSERAFIM',
        resolvedSearchItem: 'acrylic stand',
        resolvedSearchQuery: 'acrylic stand',
      })
    );

    expect(result.selectedQuery).toBe('acrylic stand');
    expect(result.preOrderListingsCount).toBe(2);
    expect(result.competitionLevel).toBe(2);
    expect(result.marketPriceUsd).toBe(22);
    expect(result.avgShippingCostUsd).toBe(4);
    expect(result.sampleSize).toBe(2);
    expect(result.queryDiagnostics?.[0]).toEqual(
      expect.objectContaining({
        rawTotalListings: 705693,
        totalListings: 2,
        rawItemSummaryCount: 3,
        itemSummaryCount: 2,
        countGuard: expect.objectContaining({ applied: true, titleMatchedCount: 2 }),
      })
    );
  });
});
