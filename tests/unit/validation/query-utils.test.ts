import { describe, expect, it } from 'vitest';
import { buildValidationEffectiveContext } from '@/validation/effective-context.js';
import { validationRunRequestSchema } from '@/validation/schemas.js';
import type { ValidationRunRequest } from '@/validation/types.js';
import {
  buildResolvedBrowseQueryPlan,
  buildResolvedRedditQueryPlan,
  buildResolvedSoldQueryPlan,
  buildResolvedTwitterQueryPlan,
  buildResolvedValidationQueryPlan,
  buildResolvedYouTubeQueryPlan,
} from '@/validation/providers/query-utils.js';

function createRequest(
  queryContext: ValidationRunRequest['validation']['queryContext'],
  itemOverrides: Partial<ValidationRunRequest['item']> = {},
  requestOverrides: Partial<ValidationRunRequest> = {}
): ValidationRunRequest {
  return {
    validationId: 'val_123',
    runType: 'manual',
    cadence: 'Off',
    timestamp: '2026-04-06T00:00:00.000Z',
    item: {
      recordId: 'rec_123',
      name: 'BTS ARIRANG Limited Album',
      variation: ['Limited'],
      itemType: ['Album'],
      releaseType: ['Album'],
      releaseDate: null,
      releasePeriod: [],
      availability: [],
      wholesalePrice: null,
      supplierNames: [],
      canonicalArtists: ['BTS'],
      relatedAlbums: ['ARIRANG'],
      ...itemOverrides,
    },
    validation: {
      validationType: 'Album Validation',
      buyDecision: 'Hold',
      automationStatus: 'Manual',
      autoCheckEnabled: false,
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
    ...requestOverrides,
  };
}

describe('resolved validation query plans', () => {
  it('keeps Direct Query overrides exclusive across providers', () => {
    const request = createRequest({
      directQueryActive: true,
      queryScope: 'Direct Query',
      resolvedSearchQuery: 'test',
    });

    const resolvedPlans = [
      buildResolvedBrowseQueryPlan(request),
      buildResolvedSoldQueryPlan(request),
      buildResolvedTwitterQueryPlan(request),
      buildResolvedYouTubeQueryPlan(request),
      buildResolvedRedditQueryPlan(request),
      buildResolvedValidationQueryPlan(request),
    ];

    for (const plan of resolvedPlans) {
      expect(plan.queryPlan).toEqual([{ family: 'resolved_query_context', query: 'test' }]);
    }
  });

  it('constrains Artist Only fallbacks to artist-only candidates across providers', () => {
    const request = createRequest(
      {
        directQueryActive: false,
        queryScope: 'Artist Only',
        resolvedSearchQuery: 'ive',
      },
      {
        name: 'IVE Official Light Stick',
        canonicalArtists: ['IVE'],
        relatedAlbums: ['IVE EMPATHY'],
      }
    );

    expect(buildResolvedBrowseQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive' },
    ]);
    expect(buildResolvedSoldQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive' },
    ]);
    expect(buildResolvedValidationQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive' },
    ]);

    expect(buildResolvedTwitterQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive' },
    ]);
    expect(buildResolvedYouTubeQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive' },
    ]);
    expect(buildResolvedRedditQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive' },
    ]);
  });

  it('suppresses unrelated fallback expansion for location-scoped resolved queries', () => {
    const request = createRequest({
      directQueryActive: false,
      queryScope: 'Artist + City / Country / State/Province',
      resolvedSearchQuery: 'ive seoul',
    });

    expect(buildResolvedSoldQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive seoul' },
    ]);
    expect(buildResolvedYouTubeQueryPlan(request).queryPlan).toEqual([
      { family: 'resolved_query_context', query: 'ive seoul' },
    ]);
  });

  it('still prepends fallback candidates for album-scoped resolved queries', () => {
    const request = createRequest({
      directQueryActive: false,
      queryScope: 'Artist + Album',
      resolvedSearchQuery: 'test',
    });

    const plan = buildResolvedBrowseQueryPlan(request);

    expect(plan.queryPlan[0]).toEqual({ family: 'resolved_query_context', query: 'test' });
    expect(plan.queryPlan.length).toBeGreaterThan(1);
    expect(plan.queryPlan.some((candidate) => candidate.family !== 'resolved_query_context')).toBe(
      true
    );
  });
});

describe('validation query context schema', () => {
  it('accepts directQueryActive in the request payload', () => {
    const parsed = validationRunRequestSchema.parse(
      createRequest({
        directQueryActive: true,
        queryScope: 'Direct Query',
        resolvedSearchQuery: 'test',
      })
    );

    expect(parsed.validation.queryContext?.directQueryActive).toBe(true);
  });

  it('accepts resolved event context fields in the request payload', () => {
    const parsed = validationRunRequestSchema.parse(
      createRequest({
        resolvedSearchArtist: 'IU',
        resolvedSearchEvent: 'H.E.R. World Tour',
        resolvedSearchLocation: 'Seoul',
        resolvedSearchItem: 'VIP package',
      })
    );

    expect(parsed.validation.queryContext?.resolvedSearchArtist).toBe('IU');
    expect(parsed.validation.queryContext?.resolvedSearchEvent).toBe('H.E.R. World Tour');
    expect(parsed.validation.queryContext?.resolvedSearchLocation).toBe('Seoul');
    expect(parsed.validation.queryContext?.resolvedSearchItem).toBe('VIP package');
  });
});

describe('effective validation context', () => {
  it('builds first-class event context without requiring item identity', () => {
    const request = createRequest(
      {
        resolvedSearchArtist: 'IU',
        resolvedSearchEvent: 'H.E.R. World Tour',
        resolvedSearchLocation: 'Seoul',
        resolvedSearchItem: 'VIP package',
      },
      {
        recordId: null,
        name: '',
        canonicalArtists: [],
        relatedAlbums: [],
      },
      {
        sourceContext: {
          sourceType: 'event',
          hasItem: false,
          hasEvent: true,
          eventRecordId: 'evt_123',
        },
      }
    );

    const effectiveContext = buildValidationEffectiveContext(request);

    expect(effectiveContext.sourceType).toBe('event');
    expect(effectiveContext.mode).toBe('event');
    expect(effectiveContext.searchArtist).toBe('IU');
    expect(effectiveContext.searchEvent).toBe('H.E.R. World Tour');
    expect(effectiveContext.searchLocation).toBe('Seoul');
    expect(effectiveContext.searchItem).toBe('VIP package');
    expect(effectiveContext.hasItem).toBe(false);
    expect(effectiveContext.hasEvent).toBe(true);
    expect(effectiveContext.effectiveSearchQuery).toContain('IU');
    expect(effectiveContext.effectiveSearchQuery).toContain('H.E.R. World Tour');
  });

  it('builds event fallback queries from normalized event context', () => {
    const request = createRequest(
      {
        resolvedSearchArtist: 'IU',
        resolvedSearchEvent: 'H.E.R. World Tour',
        resolvedSearchLocation: 'Seoul',
      },
      {
        recordId: null,
        name: '',
        canonicalArtists: [],
        relatedAlbums: [],
      },
      {
        sourceContext: {
          sourceType: 'event',
          hasItem: false,
          hasEvent: true,
          eventRecordId: 'evt_123',
        },
      }
    );

    const plan = buildResolvedBrowseQueryPlan({
      ...request,
      effectiveContext: buildValidationEffectiveContext(request),
    });

    expect(plan.queryPlan.length).toBeGreaterThan(0);
    expect(plan.queryPlan[0]?.query).toContain('IU');
    expect(plan.queryPlan.some((candidate) => candidate.query.includes('H.E.R. World Tour'))).toBe(
      true
    );
  });
});
