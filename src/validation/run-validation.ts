import type { EbaySellerApi } from '@/api/index.js';
import { validationRunRequestSchema } from './schemas.js';
import type { ValidationRunRequest, ValidationRunResponse } from './types.js';
import { getEbayValidationSignals } from './providers/ebay.js';
import { getEbaySoldValidationSignals } from './providers/ebay-sold.js';
import { getTerapeakValidationSignals } from './providers/terapeak.js';
import { getSocialValidationSignals } from './providers/social.js';
import { getChartValidationSignals } from './providers/chart.js';
import { getPreviousComebackResearchSignals } from './providers/research.js';
import { buildValidationRecommendation } from './recommendation.js';

type ResolvedSocialSignals = Awaited<ReturnType<typeof getSocialValidationSignals>>;
type ResolvedTerapeakSignals = Awaited<ReturnType<typeof getTerapeakValidationSignals>>;
type ResolvedResearchSignals = Awaited<ReturnType<typeof getPreviousComebackResearchSignals>>;

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(new Date(timestamp).getTime() + minutes * 60 * 1000).toISOString();
}

function mapErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/refresh|authorization expired|access token|token/i.test(message)) {
    return 'EBAY_AUTH_FAILED';
  }
  return 'VALIDATION_RUN_FAILED';
}

function getValidationId(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    'validationId' in input &&
    typeof input.validationId === 'string'
  ) {
    return input.validationId;
  }
  return '';
}

function buildProviderDebug(
  ebay: Awaited<ReturnType<typeof getEbayValidationSignals>>,
  sold: Awaited<ReturnType<typeof getEbaySoldValidationSignals>>,
  terapeak: ResolvedTerapeakSignals,
  social: ResolvedSocialSignals,
  chart: ReturnType<typeof getChartValidationSignals>,
  research: ResolvedResearchSignals
): Record<string, unknown> {
  return {
    ebay: {
      status: ebay.sampleSize > 0 ? 'ok' : 'partial',
      confidence: ebay.sampleSize >= 10 ? 'medium' : 'low',
      sampleSize: ebay.sampleSize,
      selectedQuery: ebay.selectedQuery,
      selectedQueryTier: ebay.selectedQueryTier,
      hasMarketPrice: ebay.marketPriceUsd !== null,
      hasShipping: ebay.avgShippingCostUsd !== null,
      hasWatchers: ebay.avgWatchersPerListing !== null,
    },
    sold: {
      status: sold.status,
      provider: sold.provider,
      confidence: sold.confidence.toLowerCase(),
      results: sold.soldResultsCount,
      selectedQuery: sold.selectedQuery,
      selectedQueryTier: sold.selectedQueryTier,
      hasMedianPrice: sold.soldMedianPriceUsd !== null,
      hasVelocity: sold.soldVelocity.daysTracked !== null,
    },
    terapeak: {
      provider: terapeak.provider,
      confidence: terapeak.confidence.toLowerCase(),
      currentQuery: terapeak.queryDebug.currentQuery,
      previousPobQuery: terapeak.queryDebug.previousPobQuery,
      selectedMode: terapeak.queryDebug.selectedMode,
      currentResultCount: terapeak.queryDebug.currentResultCount,
      previousPobResultCount: terapeak.queryDebug.previousPobResultCount,
      hasWatchers: terapeak.avgWatchersPerListing !== null,
      hasPreviousPobMetrics:
        terapeak.previousPobAvgPriceUsd !== null || terapeak.previousPobSellThroughPct !== null,
      notes: terapeak.queryDebug.notes,
    },
    social: {
      status: social.debug ? 'ok' : 'partial',
      confidence: 'low' as const,
      hasSignals:
        social.twitterTrending === true ||
        social.youtubeViews24hMillions !== null ||
        social.redditPostsCount7d !== null,
      details: social.debug,
    },
    chart: {
      status: 'stub',
      confidence: 'low',
      hasSignals: Object.keys(chart).length > 0,
    },
    research: {
      confidence: research.confidence.toLowerCase(),
      previousAlbumTitle: research.previousAlbumTitle,
      previousComebackFirstWeekSales: research.previousComebackFirstWeekSales,
      notes: research.notes,
      sources: research.sources ?? [],
    },
  };
}

export async function runValidation(
  api: EbaySellerApi,
  input: unknown
): Promise<ValidationRunResponse> {
  let request: ValidationRunRequest;

  try {
    request = validationRunRequestSchema.parse(input) as ValidationRunRequest;
  } catch (error) {
    return {
      status: 'error',
      validationId: getValidationId(input),
      errorCode: 'VALIDATION_REQUEST_INVALID',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      nextCheckAt: null,
    };
  }

  try {
    const ebay = await getEbayValidationSignals(api, request);
    const sold = await getEbaySoldValidationSignals(request);
    const terapeak = await getTerapeakValidationSignals(api, request);
    const social = await getSocialValidationSignals(request);
    const chart = getChartValidationSignals(request);
    const research = await getPreviousComebackResearchSignals(request);
    const mergedAvgWatchers = terapeak.avgWatchersPerListing ?? ebay.avgWatchersPerListing;
    const mergedPreorderListings = terapeak.preOrderListingsCount ?? ebay.preOrderListingsCount;
    const marketPriceUsd =
      terapeak.marketPriceUsd ?? sold.soldMedianPriceUsd ?? ebay.marketPriceUsd;
    const mergedAvgShippingCostUsd = terapeak.avgShippingCostUsd ?? ebay.avgShippingCostUsd;
    const mergedCompetitionLevel = terapeak.competitionLevel ?? ebay.competitionLevel;
    const soldVelocity = {
      day1Sold: sold.soldVelocity.day1Sold ?? ebay.soldVelocity.day1Sold,
      day2Sold: sold.soldVelocity.day2Sold ?? ebay.soldVelocity.day2Sold,
      day3Sold: sold.soldVelocity.day3Sold ?? ebay.soldVelocity.day3Sold,
      day4Sold: sold.soldVelocity.day4Sold ?? ebay.soldVelocity.day4Sold,
      day5Sold: sold.soldVelocity.day5Sold ?? ebay.soldVelocity.day5Sold,
      daysTracked: sold.soldVelocity.daysTracked ?? ebay.soldVelocity.daysTracked,
    };

    const recommendation = buildValidationRecommendation(request, {
      ebay,
      sold,
      terapeak,
      social,
      chart,
      research,
    });
    const mergedSignals = { ebay, sold, terapeak, social, chart, research };
    const socialWrites = {
      ...(social.twitterTrending !== null ? { twitterTrending: social.twitterTrending } : {}),
      ...(social.youtubeViews24hMillions !== null
        ? { youtubeViews24hMillions: social.youtubeViews24hMillions }
        : {}),
      ...(social.redditPostsCount7d !== null
        ? { redditPostsCount7d: social.redditPostsCount7d }
        : {}),
    };
    const terapeakWrites = {
      ...(terapeak.previousPobAvgPriceUsd !== null
        ? { previousPobAvgPriceUsd: terapeak.previousPobAvgPriceUsd }
        : {}),
      ...(terapeak.previousPobSellThroughPct !== null
        ? { previousPobSellThroughPct: terapeak.previousPobSellThroughPct }
        : {}),
    };
    const researchWrites = {
      ...(research.previousComebackFirstWeekSales !== null
        ? { previousComebackFirstWeekSales: research.previousComebackFirstWeekSales }
        : {}),
    };

    return {
      status: 'ok',
      validationId: request.validationId,
      writes: {
        avgWatchersPerListing: mergedAvgWatchers,
        preOrderListingsCount: mergedPreorderListings,
        ...socialWrites,
        marketPriceUsd,
        avgShippingCostUsd: mergedAvgShippingCostUsd,
        competitionLevel: mergedCompetitionLevel,
        marketPriceTrend: ebay.marketPriceTrend,
        day1Sold: soldVelocity.day1Sold,
        day2Sold: soldVelocity.day2Sold,
        day3Sold: soldVelocity.day3Sold,
        day4Sold: soldVelocity.day4Sold,
        day5Sold: soldVelocity.day5Sold,
        daysTracked: soldVelocity.daysTracked,
        ...terapeakWrites,
        ...researchWrites,
        monitoringNotes: recommendation.monitoringNotes,
        lastDataSnapshot: JSON.stringify(mergedSignals),
        latestAiRecommendation: recommendation.latestAiRecommendation,
        latestAiConfidence: recommendation.latestAiConfidence,
        validationError: '',
      },
      decision: {
        buyDecision: recommendation.buyDecision,
        automationStatus: recommendation.automationStatus,
        trackingCadence: recommendation.trackingCadence,
        shouldAutoTrack: recommendation.shouldAutoTrack,
        nextCheckAt: recommendation.nextCheckAt,
      },
      debug: {
        ebayQuery: ebay.ebayQuery,
        soldQuery: sold.query,
        queryCandidates: {
          ebay: ebay.queryCandidates ?? [],
          sold: sold.queryCandidates ?? [],
          terapeak: [terapeak.queryDebug.currentQuery, terapeak.queryDebug.previousPobQuery].filter(
            (value): value is string => typeof value === 'string' && value.length > 0
          ),
        },
        sampleSize: ebay.sampleSize,
        sourceSet: ['ebay', 'sold', 'terapeak', 'social', 'chart', 'research'],
        providers: buildProviderDebug(ebay, sold, terapeak, social, chart, research),
      },
    };
  } catch (error) {
    return {
      status: 'error',
      validationId: request.validationId,
      errorCode: mapErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      nextCheckAt: addMinutes(request.timestamp, 30),
    };
  }
}
