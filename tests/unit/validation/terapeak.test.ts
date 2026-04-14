import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EbayResearchResponse } from '../../../src/validation/providers/ebay-research.js';
import type { ValidationRunRequest } from '../../../src/validation/types.js';
import { buildValidationEffectiveContext } from '../../../src/validation/effective-context.js';

const fetchEbayResearchMock = vi.fn();

vi.mock('@/validation/providers/ebay-research.js', () => ({
  fetchEbayResearch: fetchEbayResearchMock,
}));

function buildResearchResponse(overrides?: {
  active?: Partial<EbayResearchResponse['active']>;
  sold?: Partial<EbayResearchResponse['sold']>;
  debug?: Partial<EbayResearchResponse['debug']>;
}): EbayResearchResponse {
  return {
    active: {
      avgListingPriceUsd: null,
      listingPriceMinUsd: null,
      listingPriceMaxUsd: null,
      avgShippingUsd: null,
      freeShippingPct: null,
      totalActiveListings: null,
      promotedListingsPct: null,
      avgWatchersPerListing: null,
      watcherCoverageCount: null,
      listingRows: [],
      ...overrides?.active,
    },
    sold: {
      avgSoldPriceUsd: null,
      soldPriceMinUsd: null,
      soldPriceMaxUsd: null,
      avgShippingUsd: null,
      freeShippingPct: null,
      sellThroughPct: null,
      totalSold: null,
      totalSellers: null,
      totalItemSalesUsd: null,
      soldRows: [],
      ...overrides?.sold,
    },
    debug: {
      query: 'ATEEZ GOLDEN HOUR',
      activeEndpointUrl: 'https://example.test/active',
      soldEndpointUrl: 'https://example.test/sold',
      fetchedAt: '2026-04-12T00:00:00.000Z',
      modulesSeen: [],
      pageErrors: [],
      authState: 'authenticated' as const,
      sessionStrategy: 'env_cookies' as const,
      sessionSource: 'env',
      sessionStoreConfigured: 'none',
      sessionStoreSelected: 'none',
      kvLoadAttempted: false,
      kvLoadSucceeded: false,
      cfKvLoadAttempted: false,
      cfKvLoadSucceeded: false,
      upstashLoadAttempted: false,
      upstashLoadSucceeded: false,
      kvStorageStateBytes: null,
      storageStateBytes: null,
      envLoadAttempted: true,
      envLoadSucceeded: true,
      filesystemLoadAttempted: false,
      filesystemLoadSucceeded: false,
      profileLoadAttempted: false,
      profileLoadSucceeded: false,
      authValidationAttempted: false,
      authValidationSucceeded: false,
      notes: [],
      ...overrides?.debug,
    },
  };
}

function buildRequest(overrides: Partial<ValidationRunRequest> = {}): ValidationRunRequest {
  const request: ValidationRunRequest = {
    validationId: 'val-1',
    runType: 'manual',
    cadence: 'Daily',
    timestamp: '2026-04-12T00:00:00.000Z',
    sourceContext: {
      sourceType: 'item',
      hasItem: true,
      hasEvent: false,
      itemRecordId: 'rec-item',
      eventRecordId: null,
    },
    item: {
      recordId: 'rec-item',
      name: 'ATEEZ GOLDEN HOUR',
      variation: [],
      itemType: ['Album'],
      releaseType: ['Album'],
      releaseDate: '2026-04-20',
      releasePeriod: [],
      availability: [],
      wholesalePrice: 10,
      supplierNames: [],
      canonicalArtists: ['ATEEZ'],
      relatedAlbums: ['GOLDEN HOUR'],
    },
    validation: {
      validationType: 'Standard Album',
      buyDecision: 'Watching',
      automationStatus: 'Watching',
      autoCheckEnabled: true,
      dDay: 0,
      artistTier: 'A',
      initialBudget: null,
      reserveBudget: null,
      queryContext: {
        validationScope: 'album',
        queryScope: 'artist album',
      },
      currentMetrics: {
        avgWatchersPerListing: null,
        preOrderListingsCount: null,
        twitterTrending: false,
        youtubeViews24hMillions: null,
        redditPostsCount7d: null,
        marketPriceUsd: null,
        avgShippingCostUsd: null,
        competitionLevel: null,
        marketPriceTrend: '',
        day1Sold: null,
        day2Sold: null,
        day3Sold: null,
        day4Sold: null,
        day5Sold: null,
        daysTracked: null,
      },
    },
    ...overrides,
  };

  return {
    ...request,
    effectiveContext: buildValidationEffectiveContext(request),
  };
}

describe('getTerapeakValidationSignals()', () => {
  beforeEach(() => {
    fetchEbayResearchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses only the resolved query when direct-query mode is active', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const baseRequest = buildRequest();
    const request = buildRequest({
      validation: {
        ...baseRequest.validation,
        queryContext: {
          validationScope: 'album',
          queryScope: 'direct query',
          directQueryActive: true,
          resolvedSearchQuery: 'ATEEZ exclusive signed drop',
        },
      },
    });

    fetchEbayResearchMock.mockResolvedValue(
      buildResearchResponse({
        debug: { query: 'ATEEZ exclusive signed drop' },
      })
    );

    await getTerapeakValidationSignals({} as never, request);

    expect(fetchEbayResearchMock).toHaveBeenCalledTimes(1);
    expect(fetchEbayResearchMock).toHaveBeenCalledWith('ATEEZ exclusive signed drop');
  });

  it('skips rejected resolved queries and falls back to generated research candidates', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const baseRequest = buildRequest();
    const request = buildRequest({
      validation: {
        ...baseRequest.validation,
        queryContext: {
          validationScope: 'album',
          queryScope: 'artist album',
          resolvedSearchQuery: 'Error: upstream resolver failed',
        },
      },
    });

    fetchEbayResearchMock.mockResolvedValue(buildResearchResponse());

    await getTerapeakValidationSignals({} as never, request);

    const queries = fetchEbayResearchMock.mock.calls.map((call): string => {
      const [query] = call as [unknown];
      return typeof query === 'string' ? query : String(query);
    });
    expect(queries).not.toContain('Error: upstream resolver failed');
    expect(queries[0]).toBe('ATEEZ GOLDEN HOUR');
  });

  it('preserves explicit zero sold buckets from research data', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const request = buildRequest();

    fetchEbayResearchMock.mockResolvedValue(
      buildResearchResponse({
        sold: {
          totalSold: 2,
          soldRows: [
            {
              title: 'ATEEZ GOLDEN HOUR listing 1',
              itemId: null,
              url: null,
              lastSoldDate: '2026-04-06T00:00:00.000Z',
            },
            {
              title: 'ATEEZ GOLDEN HOUR listing 2',
              itemId: null,
              url: null,
              lastSoldDate: '2026-04-06T12:00:00.000Z',
            },
          ],
        },
      })
    );

    const result = await getTerapeakValidationSignals({} as never, request);

    expect(result.soldVelocity.day1Sold).toBe(0);
    expect(result.soldVelocity.day2Sold).toBe(0);
    expect(result.soldVelocity.day3Sold).toBe(0);
    expect(result.soldVelocity.day4Sold).toBe(0);
    expect(result.soldVelocity.day5Sold).toBe(0);
    expect(result.soldVelocity.daysTracked).toBe(5);
  });

  it('retains previous POB research metrics when current-market selection fails', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const baseRequest = buildRequest();
    const request = buildRequest({
      validation: {
        ...baseRequest.validation,
        validationType: 'POB Album',
        queryContext: {
          validationScope: 'album',
          queryScope: 'artist album',
        },
      },
    });

    fetchEbayResearchMock
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(
        buildResearchResponse({
          sold: {
            avgSoldPriceUsd: 29.5,
            sellThroughPct: 67,
            totalSold: 12,
          },
          debug: {
            query: 'ATEEZ GOLDEN HOUR POB',
          },
        })
      )
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(buildResearchResponse())
      .mockResolvedValueOnce(buildResearchResponse());

    const result = await getTerapeakValidationSignals({} as never, request);

    expect(result.provider).toBe('ebay_research_ui');
    expect(result.previousPobAvgPriceUsd).toBe(29.5);
    expect(result.previousPobSellThroughPct).toBe(67);
    expect(result.queryDebug.previousPobQueryFamily).toBe('artist_album_subtype');
    expect(result.queryDebug.writeSources?.previousPobAvgPriceUsd).toBe('research_previous_pob_sold');
    expect(result.queryDebug.writeSources?.previousPobSellThroughPct).toBe('research_previous_pob_sold');
  });

  it('exposes a dedicated research sold price only when sold pricing exists', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const request = buildRequest();

    fetchEbayResearchMock.mockResolvedValue(
      buildResearchResponse({
        active: {
          avgListingPriceUsd: 26,
          totalActiveListings: 8,
        },
        sold: {
          avgSoldPriceUsd: 22,
          totalSold: 3,
        },
      })
    );

    const withSoldPrice = await getTerapeakValidationSignals({} as never, request);
    expect(withSoldPrice.marketPriceUsd).toBe(22);
    expect(withSoldPrice.researchSoldPriceUsd).toBe(22);

    fetchEbayResearchMock.mockReset();
    fetchEbayResearchMock.mockResolvedValue(
      buildResearchResponse({
        active: {
          avgListingPriceUsd: 26,
          totalActiveListings: 8,
        },
        sold: {
          avgSoldPriceUsd: null,
          totalSold: 3,
        },
      })
    );

    const withoutSoldPrice = await getTerapeakValidationSignals({} as never, request);
    expect(withoutSoldPrice.marketPriceUsd).toBe(26);
    expect(withoutSoldPrice.researchSoldPriceUsd).toBeNull();
  });

  it('surfaces auth/session diagnostics when no current-market candidate is usable', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const request = buildRequest();

    fetchEbayResearchMock.mockResolvedValue(
      buildResearchResponse({
        debug: {
          query: 'ATEEZ GOLDEN HOUR',
          activeEndpointUrl: 'https://example.test/current-active',
          soldEndpointUrl: 'https://example.test/current-sold',
          authState: 'expired',
          sessionStrategy: 'kv_store',
          notes: ['Authenticated eBay Research session was rejected with status 403.'],
        },
      })
    );

    const result = await getTerapeakValidationSignals({} as never, request);

    expect(result.provider).toBe('ebay_research_ui');
    expect(result.queryDebug.authState).toBe('expired');
    expect(result.queryDebug.sessionStrategy).toBe('kv_store');
    expect(result.queryDebug.currentActiveEndpointUrl).toBe('https://example.test/current-active');
    expect(result.queryDebug.currentSoldEndpointUrl).toBe('https://example.test/current-sold');
    expect(result.queryDebug.notes).toContain('Authenticated eBay Research session was rejected with status 403.');
  });

  it('stops evaluating additional research candidates after a terminal auth failure', async () => {
    const { getTerapeakValidationSignals } = await import('../../../src/validation/providers/terapeak.js');
    const request = buildRequest();

    fetchEbayResearchMock.mockResolvedValue(
      buildResearchResponse({
        debug: {
          query: 'ATEEZ GOLDEN HOUR',
          authState: 'expired',
          sessionStrategy: 'kv_store',
          notes: ['Authenticated eBay Research session was rejected with status 403.'],
        },
      })
    );

    const result = await getTerapeakValidationSignals({} as never, request);

    expect(fetchEbayResearchMock).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('ebay_research_ui');
    expect(result.queryDebug.authState).toBe('expired');
    expect(result.queryDebug.fallbackReasons).toContain(
      'Authenticated eBay Research session was rejected with status 403.'
    );
  });
});
