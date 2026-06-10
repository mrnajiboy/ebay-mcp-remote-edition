import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildValidationEffectiveContext } from '../../../src/validation/effective-context.js';
import type { ValidationRunRequest } from '../../../src/validation/types.js';

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

  return {
    ...request,
    effectiveContext: buildValidationEffectiveContext(request),
  };
}

describe('getPreviousComebackResearchSignals()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('PERPLEXITY_API_KEY', 'test-key');
    vi.stubEnv('PERPLEXITY_RESEARCH_ENABLED', 'true');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not call Perplexity unless PERPLEXITY_RESEARCH_ENABLED is explicitly true', async () => {
    vi.stubEnv('PERPLEXITY_RESEARCH_ENABLED', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { getPreviousComebackResearchSignals } = await import(
      '../../../src/validation/providers/research.js'
    );

    const result = await getPreviousComebackResearchSignals(buildRequest());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.perplexityHistoricalContextScore).toBe(0);
    expect(result.debug?.providerStatus).toBe('skipped');
    expect(result.debug?.parseStatus).toBe('skipped');
    expect(result.historicalContextNotes).toContain('disabled by default');
  });

  it('skips Perplexity when providerOptions.skipPerplexity is true', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { getPreviousComebackResearchSignals } = await import(
      '../../../src/validation/providers/research.js'
    );

    const result = await getPreviousComebackResearchSignals(
      buildRequest({ providerOptions: { skipPerplexity: true } })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.perplexityHistoricalContextScore).toBe(0);
    expect(result.debug?.providerStatus).toBe('skipped');
    expect(result.debug?.parseStatus).toBe('skipped');
  });

  it('ignores misleading numeric strings that are not clearly sales figures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  previousAlbumTitle: 'THE WORLD EP.1',
                  previousComebackFirstWeekSales: '2023 release; no reliable first-week sales found',
                  historicalContextNotes: null,
                  researchConfidence: 'Medium',
                  commercialStrengthContext: null,
                  collectorDemandContext: null,
                  preorderDemandContext: null,
                  sourceSnippets: [],
                  ambiguities: ['No sourced first-week sales figure was found.'],
                  confidenceReason: 'Only the prior release identity could be confirmed.',
                  scoreReason: null,
                  notEnoughEvidence: true,
                }),
              },
            },
          ],
          citations: [],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getPreviousComebackResearchSignals } = await import(
      '../../../src/validation/providers/research.js'
    );

    const result = await getPreviousComebackResearchSignals(buildRequest());

    expect(result.previousAlbumTitle).toBe('THE WORLD EP.1');
    expect(result.previousComebackFirstWeekSales).toBeNull();
    expect(result.perplexityHistoricalContextScore).toBe(8);
  });

  it('accepts bare numeric-string first-week sales values returned by research', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  previousAlbumTitle: 'THE WORLD EP.1',
                  previousComebackFirstWeekSales: '1350000',
                  historicalContextNotes:
                    'Previous comeback delivered strong first-week volume with broad collector demand.',
                  researchConfidence: 'High',
                  commercialStrengthContext: 'The prior album posted strong opening-week commercial momentum.',
                  collectorDemandContext: 'Collector demand remained broad across major preorder channels.',
                  preorderDemandContext: null,
                  sourceSnippets: [
                    'Industry coverage cited a 1.35M opening-week sales figure.',
                    'Fan retail summaries described strong multi-store preorder demand.',
                  ],
                  ambiguities: [],
                  confidenceReason: 'The prior release and first-week sales were directly supported.',
                  scoreReason: null,
                  notEnoughEvidence: false,
                }),
              },
            },
          ],
          citations: ['https://example.test/sales'],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getPreviousComebackResearchSignals } = await import(
      '../../../src/validation/providers/research.js'
    );

    const result = await getPreviousComebackResearchSignals(buildRequest());

    expect(result.previousAlbumTitle).toBe('THE WORLD EP.1');
    expect(result.previousComebackFirstWeekSales).toBe(1350000);
    expect(result.confidence).toBe('High');
    expect(result.perplexityHistoricalContextScore).toBeGreaterThanOrEqual(15);
  });

  it('keeps confidence and score low when only snippets exist without substantive evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  previousAlbumTitle: null,
                  previousComebackFirstWeekSales: null,
                  historicalContextNotes: null,
                  researchConfidence: 'High',
                  commercialStrengthContext: null,
                  collectorDemandContext: null,
                  preorderDemandContext: null,
                  sourceSnippets: [
                    'Forum discussion mentioned strong fan anticipation.',
                    'Collector chatter referenced broad store interest.',
                  ],
                  ambiguities: ['The available snippets did not verify a prior release or sales figure.'],
                  confidenceReason: 'Only supportive snippets were found.',
                  scoreReason: null,
                  notEnoughEvidence: false,
                }),
              },
            },
          ],
          citations: ['https://example.test/1', 'https://example.test/2'],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getPreviousComebackResearchSignals } = await import(
      '../../../src/validation/providers/research.js'
    );

    const result = await getPreviousComebackResearchSignals(buildRequest());

    expect(result.previousAlbumTitle).toBeNull();
    expect(result.previousComebackFirstWeekSales).toBeNull();
    expect(result.confidence).toBe('Low');
    expect(result.perplexityHistoricalContextScore).toBe(0);
    expect(result.debug?.providerStatus).toBe('no_evidence');
  });
});
