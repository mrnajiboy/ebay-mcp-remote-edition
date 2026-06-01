import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterSoldItemsForValidationRelevance,
  getEbaySoldValidationSignals,
} from '../../../src/validation/providers/ebay-sold.js';
import type { ValidationRunRequest } from '../../../src/validation/types.js';

function createRequest(overrides: Partial<ValidationRunRequest> = {}): ValidationRunRequest {
  return {
    validationId: 'rec58N8lisKta90Za',
    runType: 'scheduled',
    cadence: 'Daily',
    timestamp: '2026-05-25T17:20:20.501Z',
    sourceContext: {
      sourceType: 'item',
      hasItem: true,
      hasEvent: false,
      itemRecordId: 'recRRSCaaSbFnZKLp',
      eventRecordId: null,
    },
    item: {
      recordId: 'recRRSCaaSbFnZKLp',
      name: 'E2E TEST LE SSERAFIM Launch Validation Album 2 HE-E2E-20260521T050238Z',
      variation: [],
      itemType: ['Album'],
      releaseType: ['Album'],
      releaseDate: null,
      releasePeriod: [],
      availability: [],
      wholesalePrice: null,
      supplierNames: [],
      canonicalArtists: ['recdrjKzp9a2uY4mU'],
      relatedAlbums: [],
    },
    validation: {
      validationType: 'Standard Album',
      buyDecision: 'Watching',
      automationStatus: 'Ready',
      autoCheckEnabled: true,
      dDay: null,
      artistTier: 'A',
      initialBudget: null,
      reserveBudget: null,
      queryContext: {
        validationScope: 'Album',
        queryScope: 'Artist + Album',
        directQueryActive: false,
        resolvedSearchArtist: 'le sserafim',
        resolvedSearchItem: 'launch validation album 2',
        resolvedSearchEvent: '',
        resolvedSearchLocation: '',
        resolvedSearchQuery: 'le sserafim launch validation album 2',
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
        marketPriceTrend: 'Stable',
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
}

describe('eBay sold provider query context', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds broad album fallback from resolved artist text, not Airtable linked record IDs', async () => {
    vi.stubEnv('EBAY_SOLD_SEARCH_HTML_ENABLED', 'false');
    vi.stubEnv('RAPIDGATE_API_URL', '');
    vi.stubEnv('RAPIDGATE_API_KEY', '');

    const signals = await getEbaySoldValidationSignals(createRequest());

    expect(signals.broadAlbumQuery).toBe('le sserafim launch validation album 2');
    expect(signals.broadAlbumQuery).not.toContain('recdrjKzp9a2uY4mU');
    expect(signals.queryCandidates?.[0]).toBe('le sserafim launch validation album 2');
  });

  it('filters photocard-only sold-search noise from standard album validation samples', () => {
    const baseRequest = createRequest();
    const filtered = filterSoldItemsForValidationRelevance(
      [
        {
          title: 'Stray Kids MAXIDENT Official Album Sealed Ver Photocard Included',
          soldAt: '2026-05-25T00:00:00.000Z',
          priceUsd: 24.99,
          itemUrl: 'https://www.ebay.com/itm/album',
        },
        {
          title: 'Stray Kids MAXIDENT Official Photocard Bang Chan POB Lucky Draw',
          soldAt: '2026-05-25T00:00:00.000Z',
          priceUsd: 4.99,
          itemUrl: 'https://www.ebay.com/itm/pc',
        },
        {
          title: 'NewJeans unrelated photocard lot',
          soldAt: '2026-05-25T00:00:00.000Z',
          priceUsd: 999,
          itemUrl: 'https://www.ebay.com/itm/unrelated',
        },
      ],
      createRequest({
        item: {
          ...baseRequest.item,
          name: 'Stray Kids - MAXIDENT',
          canonicalArtists: ['Stray Kids'],
          relatedAlbums: ['MAXIDENT'],
        },
        validation: {
          ...baseRequest.validation,
          validationType: 'Standard Album',
          queryContext: {
            ...baseRequest.validation.queryContext,
            resolvedSearchArtist: 'stray kids',
            resolvedSearchItem: 'maxident',
            resolvedSearchQuery: 'stray kids maxident',
          },
        },
      }),
      'stray kids maxident'
    );

    expect(filtered.items.map((item) => item.itemUrl)).toEqual(['https://www.ebay.com/itm/album']);
    expect(filtered.removedCount).toBe(2);
    expect(filtered.notes).toContain('filtered out 2 low-relevance sold-search row(s)');
  });
});
