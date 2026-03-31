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

type ProviderDebugStatus = 'ok' | 'partial' | 'stub' | 'unavailable' | 'error';

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

function isMeaningfulWriteValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  return typeof value !== 'string' || value.length > 0;
}

function getFieldPresence(fields: Record<string, unknown>): {
  contributed: string[];
  omitted: string[];
} {
  const contributed: string[] = [];
  const omitted: string[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (isMeaningfulWriteValue(value)) {
      contributed.push(field);
    } else {
      omitted.push(field);
    }
  }

  return { contributed, omitted };
}

function getWriteSource(value: unknown, source: string): string {
  return isMeaningfulWriteValue(value) ? source : 'none';
}

function buildProviderDebug(
  ebay: Awaited<ReturnType<typeof getEbayValidationSignals>>,
  sold: Awaited<ReturnType<typeof getEbaySoldValidationSignals>>,
  terapeak: ResolvedTerapeakSignals,
  social: ResolvedSocialSignals,
  chart: ReturnType<typeof getChartValidationSignals>,
  research: ResolvedResearchSignals
): Record<string, unknown> {
  const ebayFields = getFieldPresence({
    avgWatchersPerListing: ebay.avgWatchersPerListing,
    preOrderListingsCount: ebay.preOrderListingsCount,
    marketPriceUsd: ebay.marketPriceUsd,
    avgShippingCostUsd: ebay.avgShippingCostUsd,
    competitionLevel: ebay.competitionLevel,
  });
  const soldFields = getFieldPresence({
    soldAveragePriceUsd: sold.soldAveragePriceUsd,
    soldMedianPriceUsd: sold.soldMedianPriceUsd,
    soldMinPriceUsd: sold.soldMinPriceUsd,
    soldMaxPriceUsd: sold.soldMaxPriceUsd,
    day1Sold: sold.soldVelocity.day1Sold,
    day2Sold: sold.soldVelocity.day2Sold,
    day3Sold: sold.soldVelocity.day3Sold,
    day4Sold: sold.soldVelocity.day4Sold,
    day5Sold: sold.soldVelocity.day5Sold,
    daysTracked: sold.soldVelocity.daysTracked,
  });
  const terapeakFields = getFieldPresence({
    avgWatchersPerListing: terapeak.avgWatchersPerListing,
    preOrderListingsCount: terapeak.preOrderListingsCount,
    marketPriceUsd: terapeak.marketPriceUsd,
    avgShippingCostUsd: terapeak.avgShippingCostUsd,
    competitionLevel: terapeak.competitionLevel,
    previousPobAvgPriceUsd: terapeak.previousPobAvgPriceUsd,
    previousPobSellThroughPct: terapeak.previousPobSellThroughPct,
  });
  const socialFields = getFieldPresence({
    twitterTrending: social.twitterTrending,
    youtubeViews24hMillions: social.youtubeViews24hMillions,
    redditPostsCount7d: social.redditPostsCount7d,
  });
  const researchFields = getFieldPresence({
    previousAlbumTitle: research.previousAlbumTitle,
    previousComebackFirstWeekSales: research.previousComebackFirstWeekSales,
  });

  const ebayStatus: ProviderDebugStatus =
    (ebay.queryCandidates?.length ?? 0) === 0
      ? 'unavailable'
      : ebay.sampleSize > 0
        ? 'ok'
        : 'partial';
  const socialStatus: ProviderDebugStatus =
    socialFields.contributed.length > 0 ? 'ok' : social.debug ? 'partial' : 'unavailable';
  const terapeakStatus: ProviderDebugStatus =
    terapeak.provider === 'none'
      ? 'stub'
      : terapeakFields.contributed.length > 0
        ? 'ok'
        : 'partial';
  const researchStatus: ProviderDebugStatus =
    research.previousComebackFirstWeekSales !== null || research.previousAlbumTitle !== null
      ? 'ok'
      : 'stub';

  return {
    ebay: {
      status: ebayStatus,
      confidence: ebay.sampleSize >= 10 ? 'medium' : 'low',
      browseSampleSize: ebay.sampleSize,
      queryCandidates: ebay.queryCandidates ?? [],
      selectedQuery: ebay.selectedQuery,
      selectedQueryTier: ebay.selectedQueryTier,
      queryDiagnostics: ebay.queryDiagnostics ?? [],
      selectionReason: ebay.selectionReason,
      errorMessage: ebay.errorMessage,
      responseStatus: ebay.responseStatus,
      responseBodyExcerpt: ebay.responseBodyExcerpt,
      contributedFields: ebayFields.contributed,
      omittedFields: ebayFields.omitted,
    },
    sold: {
      status: sold.status,
      provider: sold.provider,
      confidence: sold.confidence.toLowerCase(),
      soldResultsCount: sold.soldResultsCount,
      queryCandidates: sold.queryCandidates ?? [],
      selectedQuery: sold.selectedQuery,
      selectedQueryTier: sold.selectedQueryTier,
      contributedFields: soldFields.contributed,
      omittedFields: soldFields.omitted,
      errorMessage: sold.errorMessage,
    },
    terapeak: {
      status: terapeakStatus,
      provider: terapeak.provider,
      confidence: terapeak.confidence.toLowerCase(),
      queryCandidates: [
        terapeak.queryDebug.currentQuery,
        terapeak.queryDebug.previousPobQuery,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      currentQuery: terapeak.queryDebug.currentQuery,
      previousPobQuery: terapeak.queryDebug.previousPobQuery,
      selectedMode: terapeak.queryDebug.selectedMode,
      currentResultCount: terapeak.queryDebug.currentResultCount,
      previousPobResultCount: terapeak.queryDebug.previousPobResultCount,
      contributedFields: terapeakFields.contributed,
      omittedFields: terapeakFields.omitted,
      notes: terapeak.queryDebug.notes,
    },
    social: {
      status: socialStatus,
      confidence: 'low' as const,
      contributedFields: socialFields.contributed,
      omittedFields: socialFields.omitted,
      details: social.debug,
    },
    chart: {
      status: 'stub',
      confidence: 'low',
      contributedFields: [],
      omittedFields: ['chartMomentum'],
    },
    research: {
      status: researchStatus,
      confidence: research.confidence.toLowerCase(),
      previousAlbumTitle: research.previousAlbumTitle,
      previousComebackFirstWeekSales: research.previousComebackFirstWeekSales,
      contributedFields: researchFields.contributed,
      omittedFields: researchFields.omitted,
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
    const writeResolution = {
      avgWatchersPerListing:
        terapeak.avgWatchersPerListing !== null
          ? 'terapeak'
          : getWriteSource(ebay.avgWatchersPerListing, 'ebay'),
      preOrderListingsCount:
        terapeak.preOrderListingsCount !== null
          ? 'terapeak'
          : getWriteSource(ebay.preOrderListingsCount, 'ebay'),
      marketPriceUsd:
        terapeak.marketPriceUsd !== null
          ? 'terapeak'
          : sold.soldMedianPriceUsd !== null
            ? 'sold'
            : getWriteSource(ebay.marketPriceUsd, 'ebay'),
      avgShippingCostUsd:
        terapeak.avgShippingCostUsd !== null
          ? 'terapeak'
          : getWriteSource(ebay.avgShippingCostUsd, 'ebay'),
      competitionLevel:
        terapeak.competitionLevel !== null
          ? 'terapeak'
          : getWriteSource(ebay.competitionLevel, 'ebay'),
      twitterTrending: getWriteSource(social.twitterTrending, 'social'),
      youtubeViews24hMillions: getWriteSource(social.youtubeViews24hMillions, 'social'),
      redditPostsCount7d: getWriteSource(social.redditPostsCount7d, 'social'),
      day1Sold:
        sold.soldVelocity.day1Sold !== null
          ? 'sold'
          : getWriteSource(ebay.soldVelocity.day1Sold, 'ebay'),
      day2Sold:
        sold.soldVelocity.day2Sold !== null
          ? 'sold'
          : getWriteSource(ebay.soldVelocity.day2Sold, 'ebay'),
      day3Sold:
        sold.soldVelocity.day3Sold !== null
          ? 'sold'
          : getWriteSource(ebay.soldVelocity.day3Sold, 'ebay'),
      day4Sold:
        sold.soldVelocity.day4Sold !== null
          ? 'sold'
          : getWriteSource(ebay.soldVelocity.day4Sold, 'ebay'),
      day5Sold:
        sold.soldVelocity.day5Sold !== null
          ? 'sold'
          : getWriteSource(ebay.soldVelocity.day5Sold, 'ebay'),
      daysTracked:
        sold.soldVelocity.daysTracked !== null
          ? 'sold'
          : getWriteSource(ebay.soldVelocity.daysTracked, 'ebay'),
      previousPobAvgPriceUsd: getWriteSource(terapeak.previousPobAvgPriceUsd, 'terapeak'),
      previousPobSellThroughPct: getWriteSource(terapeak.previousPobSellThroughPct, 'terapeak'),
      previousComebackFirstWeekSales: getWriteSource(
        research.previousComebackFirstWeekSales,
        'research'
      ),
    };
    const omittedOptionalWrites = Object.entries(writeResolution)
      .filter(([, source]) => source === 'none')
      .map(([field]) => field);

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
        browseSampleSize: ebay.sampleSize,
        soldResultsCount: sold.soldResultsCount,
        omittedOptionalWrites,
        writeResolution,
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
