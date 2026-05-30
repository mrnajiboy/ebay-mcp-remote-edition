import type { EbaySellerApi } from '@/api/index.js';
import { validationRunRequestSchema } from './schemas.js';
import type { ValidationRunRequest, ValidationRunResponse } from './types.js';
import { getEbayValidationSignals } from './providers/ebay.js';
import { getEbaySoldValidationSignals } from './providers/ebay-sold.js';
import { getTerapeakValidationSignals } from './providers/terapeak.js';
import { getSocialValidationSignals } from './providers/social.js';
import { getChartValidationSignals } from './providers/chart.js';
import { getPreviousComebackResearchSignals } from './providers/research.js';
import { buildProviderQueryResolutionDebug } from './providers/query-utils.js';
import { buildValidationRecommendation } from './recommendation.js';
import { buildValidationEffectiveContext } from './effective-context.js';

type ResolvedSocialSignals = Awaited<ReturnType<typeof getSocialValidationSignals>>;
type ResolvedTerapeakSignals = Awaited<ReturnType<typeof getTerapeakValidationSignals>>;
type ResolvedResearchSignals = Awaited<ReturnType<typeof getPreviousComebackResearchSignals>>;

type ProviderDebugStatus = 'ok' | 'partial' | 'stub' | 'unavailable' | 'error' | 'skipped';

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

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

const MAX_UNVERIFIED_ACTIVE_LISTING_COUNT = 1000;

function guardAggregateListingCount(
  aggregateCount: number | null,
  sampledRowCount: number | null | undefined
): { value: number | null; guardSource: string | null } {
  if (aggregateCount === null || aggregateCount <= MAX_UNVERIFIED_ACTIVE_LISTING_COUNT) {
    return { value: aggregateCount, guardSource: null };
  }

  if (
    typeof sampledRowCount === 'number' &&
    Number.isFinite(sampledRowCount) &&
    sampledRowCount > 0 &&
    sampledRowCount <= MAX_UNVERIFIED_ACTIVE_LISTING_COUNT
  ) {
    return { value: sampledRowCount, guardSource: 'research_active_row_guard' };
  }

  return { value: null, guardSource: 'research_active_suppressed_unverified_total' };
}

function hasSoldVelocityEvidence(soldVelocity: {
  day1Sold: number | null;
  day2Sold: number | null;
  day3Sold: number | null;
  day4Sold: number | null;
  day5Sold: number | null;
  daysTracked: number | null;
}): boolean {
  return Object.values(soldVelocity).some((value) => value !== null);
}

function hasPrimaryResearchSoldSignals(terapeak: ResolvedTerapeakSignals): boolean {
  return (
    terapeak.provider === 'ebay_research_ui' &&
    (terapeak.researchSoldPriceUsd !== null ||
      terapeak.soldListingsCount !== null ||
      terapeak.recentSoldCount7d !== null ||
      hasSoldVelocityEvidence(terapeak.soldVelocity))
  );
}

function createSkippedSoldSignals(): Awaited<ReturnType<typeof getEbaySoldValidationSignals>> {
  return {
    provider: 'third_party_sold_api',
    confidence: 'Low',
    soldResultsCount: null,
    soldAveragePriceUsd: null,
    soldMedianPriceUsd: null,
    soldMinPriceUsd: null,
    soldMaxPriceUsd: null,
    soldItemsSample: [],
    soldVelocity: {
      day1Sold: null,
      day2Sold: null,
      day3Sold: null,
      day4Sold: null,
      day5Sold: null,
      daysTracked: null,
    },
    recentSoldCount7d: null,
    soldBucketDebug: {
      status: 'skipped',
      notes: [
        'legacy sold fallback was skipped because first-party research sold signals were sufficient',
      ],
      totalItemsExamined: 0,
      withSoldAt: 0,
      missingSoldAt: 0,
      dateParseFailures: 0,
      futureDated: 0,
      bucketedItems: 0,
    },
    query: null,
    queryCandidates: [],
    queryDiagnostics: [],
    selectedQuery: undefined,
    selectedQueryTier: null,
    selectedQueryFamily: null,
    broadAlbumQuery: null,
    subtypeSpecificQuery: null,
    querySelectionReason:
      'Legacy sold fallback was skipped because first-party research sold signals were sufficient.',
    responseUrl: null,
    status: 'skipped',
    errorMessage: undefined,
    queryResolution: undefined,
  };
}

function resolvePreferredSoldMetric(
  terapeakValue: number | null,
  soldValue: number | null,
  ebayValue: number | null
): {
  value: number | null;
  source: 'sold' | 'terapeak' | 'ebay' | 'none';
} {
  if (terapeakValue !== null) {
    return { value: terapeakValue, source: 'terapeak' };
  }

  if (soldValue !== null) {
    return { value: soldValue, source: 'sold' };
  }

  if (ebayValue !== null) {
    return { value: ebayValue, source: 'ebay' };
  }

  return { value: null, source: 'none' };
}

function buildProviderDebug(
  request: ValidationRunRequest,
  ebay: Awaited<ReturnType<typeof getEbayValidationSignals>>,
  sold: Awaited<ReturnType<typeof getEbaySoldValidationSignals>>,
  terapeak: ResolvedTerapeakSignals,
  social: ResolvedSocialSignals,
  chart: ReturnType<typeof getChartValidationSignals>,
  research: ResolvedResearchSignals
): Record<string, unknown> {
  const requestQueryResolution = buildProviderQueryResolutionDebug(
    request,
    Boolean(ebay.queryResolution?.queryContextUsed)
  );
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
    activeAvgPriceUsd: terapeak.activeAvgPriceUsd,
    activeAvgShippingUsd: terapeak.activeAvgShippingUsd,
    activeListingsCount: terapeak.activeListingsCount,
    activeAvgWatchersPerListing: terapeak.activeAvgWatchersPerListing,
    soldAvgPriceUsd: terapeak.soldAvgPriceUsd,
    soldMedianPriceUsd: terapeak.soldMedianPriceUsd,
    soldAvgShippingUsd: terapeak.soldAvgShippingUsd,
    marketPriceUsd: terapeak.marketPriceUsd,
    avgShippingCostUsd: terapeak.avgShippingCostUsd,
    competitionLevel: terapeak.competitionLevel,
    soldSellThroughPct: terapeak.soldSellThroughPct,
    soldTotalRevenueUsd: terapeak.soldTotalRevenueUsd,
    previousPobAvgPriceUsd: terapeak.previousPobAvgPriceUsd,
    previousPobSellThroughPct: terapeak.previousPobSellThroughPct,
    day1Sold: terapeak.soldVelocity.day1Sold,
    day2Sold: terapeak.soldVelocity.day2Sold,
    day3Sold: terapeak.soldVelocity.day3Sold,
    day4Sold: terapeak.soldVelocity.day4Sold,
    day5Sold: terapeak.soldVelocity.day5Sold,
    daysTracked: terapeak.soldVelocity.daysTracked,
  });
  const socialFields = getFieldPresence({
    twitterTrending: social.twitterTrending,
    youtubeViews24hMillions: social.youtubeViews24hMillions,
    redditPostsCount7d: social.redditPostsCount7d,
  });
  const researchFields = getFieldPresence({
    previousAlbumTitle: research.previousAlbumTitle,
    previousComebackFirstWeekSales: research.previousComebackFirstWeekSales,
    perplexityHistoricalContextScore: research.perplexityHistoricalContextScore,
    historicalContextNotes: research.historicalContextNotes,
    researchConfidence: research.confidence,
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
    research.debug?.providerStatus === 'unconfigured'
      ? 'unavailable'
      : research.debug?.providerStatus === 'error'
        ? 'partial'
        : research.previousComebackFirstWeekSales !== null ||
            research.previousAlbumTitle !== null ||
            research.perplexityHistoricalContextScore > 0
          ? 'ok'
          : 'partial';

  return {
    ebay: {
      status: ebayStatus,
      confidence: ebay.sampleSize >= 10 ? 'medium' : 'low',
      browseSampleSize: ebay.sampleSize,
      queryCandidates: ebay.queryCandidates ?? [],
      selectedQuery: ebay.selectedQuery,
      selectedQueryTier: ebay.selectedQueryTier,
      queryDiagnostics: ebay.queryDiagnostics ?? [],
      queryContextUsed:
        ebay.queryResolution?.queryContextUsed ?? requestQueryResolution.queryContextUsed,
      querySource: ebay.queryResolution?.querySource ?? requestQueryResolution.querySource,
      resolvedSearchQuery:
        ebay.queryResolution?.resolvedSearchQuery ?? requestQueryResolution.resolvedSearchQuery,
      validationScope:
        ebay.queryResolution?.validationScope ?? requestQueryResolution.validationScope,
      queryScope: ebay.queryResolution?.queryScope ?? requestQueryResolution.queryScope,
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
      recentSoldCount7d: sold.recentSoldCount7d,
      queryCandidates: sold.queryCandidates ?? [],
      selectedQuery: sold.selectedQuery,
      selectedQueryTier: sold.selectedQueryTier,
      selectedQueryFamily: sold.selectedQueryFamily,
      broadAlbumQuery: sold.broadAlbumQuery,
      subtypeSpecificQuery: sold.subtypeSpecificQuery,
      queryDiagnostics: sold.queryDiagnostics ?? [],
      querySelectionReason: sold.querySelectionReason,
      soldBucketDebug: sold.soldBucketDebug,
      queryContextUsed:
        sold.queryResolution?.queryContextUsed ?? requestQueryResolution.queryContextUsed,
      querySource: sold.queryResolution?.querySource ?? requestQueryResolution.querySource,
      resolvedSearchQuery:
        sold.queryResolution?.resolvedSearchQuery ?? requestQueryResolution.resolvedSearchQuery,
      validationScope:
        sold.queryResolution?.validationScope ?? requestQueryResolution.validationScope,
      queryScope: sold.queryResolution?.queryScope ?? requestQueryResolution.queryScope,
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
      queryContextUsed:
        terapeak.queryDebug.queryResolution?.queryContextUsed ??
        requestQueryResolution.queryContextUsed,
      querySource:
        terapeak.queryDebug.queryResolution?.querySource ?? requestQueryResolution.querySource,
      resolvedSearchQuery:
        terapeak.queryDebug.queryResolution?.resolvedSearchQuery ??
        requestQueryResolution.resolvedSearchQuery,
      validationScope:
        terapeak.queryDebug.queryResolution?.validationScope ??
        requestQueryResolution.validationScope,
      queryScope:
        terapeak.queryDebug.queryResolution?.queryScope ?? requestQueryResolution.queryScope,
      selectedMode: terapeak.queryDebug.selectedMode,
      currentQueryFamily: terapeak.queryDebug.currentQueryFamily,
      previousPobQueryFamily: terapeak.queryDebug.previousPobQueryFamily,
      currentResultCount: terapeak.queryDebug.currentResultCount,
      previousPobResultCount: terapeak.queryDebug.previousPobResultCount,
      currentWatcherCoverageCount: terapeak.queryDebug.currentWatcherCoverageCount,
      previousPobWatcherCoverageCount: terapeak.queryDebug.previousPobWatcherCoverageCount,
      candidateDiagnostics: terapeak.queryDebug.candidateDiagnostics ?? [],
      previousPobCandidateDiagnostics: terapeak.queryDebug.previousPobCandidateDiagnostics ?? [],
      fallbackReasons: terapeak.queryDebug.fallbackReasons ?? [],
      writeSources: terapeak.queryDebug.writeSources ?? {},
      currentModulesSeen: terapeak.queryDebug.currentModulesSeen,
      previousPobModulesSeen: terapeak.queryDebug.previousPobModulesSeen,
      currentPageErrors: terapeak.queryDebug.currentPageErrors,
      previousPobPageErrors: terapeak.queryDebug.previousPobPageErrors,
      antiBotDetection: terapeak.queryDebug.antiBotDetection,
      currentActiveParse: terapeak.queryDebug.currentActiveParse,
      currentSoldParse: terapeak.queryDebug.currentSoldParse,
      previousPobActiveParse: terapeak.queryDebug.previousPobActiveParse,
      previousPobSoldParse: terapeak.queryDebug.previousPobSoldParse,
      currentActiveEndpointUrl: terapeak.queryDebug.currentActiveEndpointUrl,
      currentSoldEndpointUrl: terapeak.queryDebug.currentSoldEndpointUrl,
      previousPobActiveEndpointUrl: terapeak.queryDebug.previousPobActiveEndpointUrl,
      previousPobSoldEndpointUrl: terapeak.queryDebug.previousPobSoldEndpointUrl,
      soldBucketDebug: terapeak.soldBucketDebug,
      recentSoldCount7d: terapeak.recentSoldCount7d,
      authState: terapeak.queryDebug.authState,
      sessionStrategy: terapeak.queryDebug.sessionStrategy,
      sessionSource: terapeak.queryDebug.sessionSource,
      sessionStoreConfigured: terapeak.queryDebug.sessionStoreConfigured,
      sessionStoreSelected: terapeak.queryDebug.sessionStoreSelected,
      kvLoadAttempted: terapeak.queryDebug.kvLoadAttempted,
      kvLoadSucceeded: terapeak.queryDebug.kvLoadSucceeded,
      cfKvLoadAttempted: terapeak.queryDebug.cfKvLoadAttempted,
      cfKvLoadSucceeded: terapeak.queryDebug.cfKvLoadSucceeded,
      upstashLoadAttempted: terapeak.queryDebug.upstashLoadAttempted,
      upstashLoadSucceeded: terapeak.queryDebug.upstashLoadSucceeded,
      kvStorageStateBytes: terapeak.queryDebug.kvStorageStateBytes,
      storageStateBytes: terapeak.queryDebug.storageStateBytes,
      envLoadAttempted: terapeak.queryDebug.envLoadAttempted,
      envLoadSucceeded: terapeak.queryDebug.envLoadSucceeded,
      filesystemLoadAttempted: terapeak.queryDebug.filesystemLoadAttempted,
      filesystemLoadSucceeded: terapeak.queryDebug.filesystemLoadSucceeded,
      profileLoadAttempted: terapeak.queryDebug.profileLoadAttempted,
      profileLoadSucceeded: terapeak.queryDebug.profileLoadSucceeded,
      authValidationAttempted: terapeak.queryDebug.authValidationAttempted,
      authValidationSucceeded: terapeak.queryDebug.authValidationSucceeded,
      contributedFields: terapeakFields.contributed,
      omittedFields: terapeakFields.omitted,
      notes: terapeak.queryDebug.notes,
    },
    social: {
      status: socialStatus,
      confidence: 'low' as const,
      queryContextUsed: requestQueryResolution.queryContextUsed,
      querySource: requestQueryResolution.querySource,
      resolvedSearchQuery: requestQueryResolution.resolvedSearchQuery,
      validationScope: requestQueryResolution.validationScope,
      queryScope: requestQueryResolution.queryScope,
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
      perplexityHistoricalContextScore: research.perplexityHistoricalContextScore,
      historicalContextNotes: research.historicalContextNotes,
      contributedFields: researchFields.contributed,
      omittedFields: researchFields.omitted,
      notes: research.notes,
      sources: research.sources ?? [],
      query: research.debug?.query ?? null,
      promptFocus: research.debug?.promptFocus ?? [],
      sourceSnippets: research.debug?.sourceSnippets ?? [],
      resolvedPriorRelease: research.debug?.resolvedPriorRelease ?? research.previousAlbumTitle,
      extractedConfidence: research.debug?.extractedConfidence ?? null,
      computedConfidence: research.debug?.computedConfidence ?? research.confidence,
      confidenceReason: research.debug?.confidenceReason ?? null,
      scoreAssignmentReason: research.debug?.scoreAssignmentReason ?? null,
      providerStatus: research.debug?.providerStatus ?? null,
      parseStatus: research.debug?.parseStatus ?? null,
      errorMessage: research.debug?.errorMessage ?? null,
    },
  };
}

export async function runValidation(
  api: EbaySellerApi,
  input: unknown
): Promise<ValidationRunResponse> {
  let request: ValidationRunRequest;

  try {
    request = validationRunRequestSchema.parse(input);
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
    const effectiveContext = buildValidationEffectiveContext(request);
    const effectiveRequest: ValidationRunRequest = {
      ...request,
      effectiveContext,
    };
    const ebay = await getEbayValidationSignals(api, effectiveRequest);
    const terapeak = await getTerapeakValidationSignals(api, effectiveRequest);
    const primaryResearchSoldSignalsAvailable = hasPrimaryResearchSoldSignals(terapeak);
    const sold = primaryResearchSoldSignalsAvailable
      ? createSkippedSoldSignals()
      : await getEbaySoldValidationSignals(effectiveRequest);
    const social = await getSocialValidationSignals(effectiveRequest);
    const chart = getChartValidationSignals(effectiveRequest);
    const research = await getPreviousComebackResearchSignals(effectiveRequest);
    const marketPriceWriteSource = terapeak.queryDebug.writeSources?.marketPriceUsd ?? null;
    const avgShippingWriteSource = terapeak.queryDebug.writeSources?.avgShippingCostUsd ?? null;
    const rawNormalizedTerapeakActiveListingsCount =
      terapeak.activeListingsCount ??
      terapeak.currentListingsCount ??
      terapeak.preOrderListingsCount;
    const guardedTerapeakActiveListingsCount = guardAggregateListingCount(
      rawNormalizedTerapeakActiveListingsCount,
      terapeak.queryDebug.currentActiveParse?.rowCount ?? terapeak.queryDebug.currentResultCount
    );
    const normalizedTerapeakActiveListingsCount = guardedTerapeakActiveListingsCount.value;
    const researchActiveListingsWriteSource =
      guardedTerapeakActiveListingsCount.guardSource ??
      terapeak.queryDebug.writeSources?.activeListingsCount ??
      'research_active';
    const normalizedTerapeakActiveAvgWatchersPerListing =
      terapeak.activeAvgWatchersPerListing ?? terapeak.avgWatchersPerListing;
    const normalizedTerapeakActiveAvgPriceUsd =
      terapeak.activeAvgPriceUsd ??
      (marketPriceWriteSource?.startsWith('research_active') ? terapeak.marketPriceUsd : null);
    const normalizedTerapeakSoldAvgPriceUsd =
      terapeak.soldAvgPriceUsd ??
      terapeak.researchSoldPriceUsd ??
      (marketPriceWriteSource?.startsWith('research_sold') ? terapeak.marketPriceUsd : null);
    const normalizedTerapeakActiveAvgShippingUsd =
      terapeak.activeAvgShippingUsd ??
      (avgShippingWriteSource?.startsWith('research_active') ? terapeak.avgShippingCostUsd : null);
    const normalizedTerapeakSoldAvgShippingUsd =
      terapeak.soldAvgShippingUsd ??
      (avgShippingWriteSource?.startsWith('research_sold') ? terapeak.avgShippingCostUsd : null);
    const mergedAvgWatchers =
      normalizedTerapeakActiveAvgWatchersPerListing ?? ebay.avgWatchersPerListing;
    const mergedPreorderListings =
      normalizedTerapeakActiveListingsCount ?? ebay.preOrderListingsCount;
    const activeAvgPriceUsd = normalizedTerapeakActiveAvgPriceUsd ?? ebay.marketPriceUsd;
    const activeAvgShippingUsd = normalizedTerapeakActiveAvgShippingUsd ?? ebay.avgShippingCostUsd;
    const activeListingsCount = mergedPreorderListings;
    const activeAvgWatchersPerListing = mergedAvgWatchers;
    const soldAvgPriceUsd = normalizedTerapeakSoldAvgPriceUsd ?? sold.soldAveragePriceUsd;
    const soldMedianPriceUsd = terapeak.soldMedianPriceUsd ?? sold.soldMedianPriceUsd;
    const soldAvgShippingUsd = normalizedTerapeakSoldAvgShippingUsd;
    const soldListingsCount = terapeak.soldListingsCount ?? sold.soldResultsCount;
    const soldSellThroughPct = terapeak.soldSellThroughPct;
    const soldTotalRevenueUsd = terapeak.soldTotalRevenueUsd;
    const normalizedTerapeakMarketPriceUsd =
      terapeak.marketPriceUsd ?? normalizedTerapeakActiveAvgPriceUsd;
    const marketPriceUsd =
      normalizedTerapeakMarketPriceUsd ?? sold.soldMedianPriceUsd ?? ebay.marketPriceUsd;
    const mergedAvgShippingCostUsd =
      normalizedTerapeakSoldAvgShippingUsd ??
      normalizedTerapeakActiveAvgShippingUsd ??
      ebay.avgShippingCostUsd;
    const mergedCompetitionLevel = normalizedTerapeakActiveListingsCount ?? ebay.competitionLevel;
    const finalFieldSources = {
      marketPriceUsd: isPresent(normalizedTerapeakMarketPriceUsd)
        ? (marketPriceWriteSource ??
          (isPresent(normalizedTerapeakActiveAvgPriceUsd) ? 'research_active' : 'research_sold'))
        : sold.soldMedianPriceUsd !== null
          ? 'sold'
          : ebay.marketPriceUsd !== null
            ? 'ebay'
            : 'none',
      avgShippingCostUsd: isPresent(normalizedTerapeakSoldAvgShippingUsd)
        ? (avgShippingWriteSource ?? 'research_sold')
        : isPresent(normalizedTerapeakActiveAvgShippingUsd)
          ? (avgShippingWriteSource ?? 'research_active')
          : mergedAvgShippingCostUsd !== null
            ? 'ebay'
            : 'none',
      competitionLevel: isPresent(normalizedTerapeakActiveListingsCount)
        ? researchActiveListingsWriteSource
        : mergedCompetitionLevel !== null
          ? 'ebay'
          : 'none',
    };
    const day1Sold = resolvePreferredSoldMetric(
      terapeak.soldVelocity.day1Sold,
      sold.soldVelocity.day1Sold,
      ebay.soldVelocity.day1Sold
    );
    const day2Sold = resolvePreferredSoldMetric(
      terapeak.soldVelocity.day2Sold,
      sold.soldVelocity.day2Sold,
      ebay.soldVelocity.day2Sold
    );
    const day3Sold = resolvePreferredSoldMetric(
      terapeak.soldVelocity.day3Sold,
      sold.soldVelocity.day3Sold,
      ebay.soldVelocity.day3Sold
    );
    const day4Sold = resolvePreferredSoldMetric(
      terapeak.soldVelocity.day4Sold,
      sold.soldVelocity.day4Sold,
      ebay.soldVelocity.day4Sold
    );
    const day5Sold = resolvePreferredSoldMetric(
      terapeak.soldVelocity.day5Sold,
      sold.soldVelocity.day5Sold,
      ebay.soldVelocity.day5Sold
    );
    const daysTracked = resolvePreferredSoldMetric(
      terapeak.soldVelocity.daysTracked,
      sold.soldVelocity.daysTracked,
      ebay.soldVelocity.daysTracked
    );
    const soldVelocity = {
      day1Sold: day1Sold.value,
      day2Sold: day2Sold.value,
      day3Sold: day3Sold.value,
      day4Sold: day4Sold.value,
      day5Sold: day5Sold.value,
      daysTracked: daysTracked.value,
    };

    const recommendation = buildValidationRecommendation(effectiveRequest, {
      ebay,
      sold,
      terapeak,
      social,
      chart,
      research,
      effectiveContext,
      // Artist momentum score from Artist/Group table — passed via currentMetrics
      momentumScore: effectiveRequest.validation.currentMetrics.artistMomentumScore ?? null,
    });
    const requestQueryResolution = buildProviderQueryResolutionDebug(
      effectiveRequest,
      Boolean(ebay.queryResolution?.queryContextUsed)
    );
    const mergedSignals = { effectiveContext, ebay, sold, terapeak, social, chart, research };
    const activeSource =
      isPresent(normalizedTerapeakActiveAvgWatchersPerListing) ||
      isPresent(normalizedTerapeakActiveListingsCount) ||
      isPresent(normalizedTerapeakActiveAvgPriceUsd) ||
      isPresent(normalizedTerapeakActiveAvgShippingUsd)
        ? 'ebay_research_ui'
        : ebay.preOrderListingsCount !== null ||
            ebay.marketPriceUsd !== null ||
            ebay.competitionLevel !== null
          ? 'ebay_browse'
          : 'none';
    const soldSource = primaryResearchSoldSignalsAvailable
      ? 'ebay_research_ui'
      : sold.soldMedianPriceUsd !== null ||
          sold.soldAveragePriceUsd !== null ||
          sold.soldResultsCount !== null ||
          hasSoldVelocityEvidence(sold.soldVelocity)
        ? 'third_party_sold_api'
        : ebay.marketPriceUsd !== null
          ? 'ebay_browse'
          : 'none';
    const researchAuthUnavailable =
      terapeak.queryDebug.authState === 'missing' ||
      terapeak.queryDebug.authState === 'expired' ||
      terapeak.queryDebug.authState === 'unavailable';
    const providerResolution = {
      activeSource,
      soldSource,
      soldFallbackUsed:
        !primaryResearchSoldSignalsAvailable && soldSource === 'third_party_sold_api',
      fallbackReason: primaryResearchSoldSignalsAvailable
        ? null
        : soldSource === 'third_party_sold_api'
          ? researchAuthUnavailable
            ? `ebay_research_ui auth unavailable (state=${terapeak.queryDebug.authState ?? 'unknown'}, source=${terapeak.queryDebug.sessionSource ?? 'none'}), so the legacy sold provider was used as automatic fallback.`
            : 'ebay_research_ui returned insufficient sold signals, so the legacy sold provider was used as automatic fallback.'
          : 'First-party research sold signals were unavailable or insufficient, but no legacy sold fallback data was available.',
    };
    const hasUsableHistoricalResearch =
      research.debug?.providerStatus !== undefined
        ? research.debug.providerStatus === 'ok'
        : research.previousAlbumTitle !== null ||
          research.previousComebackFirstWeekSales !== null ||
          research.perplexityHistoricalContextScore > 0;
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
      ...(hasUsableHistoricalResearch
        ? {
            perplexityHistoricalContextScore: research.perplexityHistoricalContextScore,
            historicalContextNotes: research.historicalContextNotes,
            researchConfidence: research.confidence,
          }
        : {}),
      ...(hasUsableHistoricalResearch && research.previousComebackFirstWeekSales !== null
        ? { previousComebackFirstWeekSales: research.previousComebackFirstWeekSales }
        : {}),
    };
    const writeResolution = {
      avgWatchersPerListing:
        activeAvgWatchersPerListing !== null
          ? terapeak.activeAvgWatchersPerListing !== null
            ? (terapeak.queryDebug.writeSources?.activeAvgWatchersPerListing ?? 'research_active')
            : 'ebay'
          : 'none',
      preOrderListingsCount:
        activeListingsCount !== null
          ? isPresent(normalizedTerapeakActiveListingsCount)
            ? researchActiveListingsWriteSource
            : 'ebay'
          : 'none',
      activeAvgPriceUsd:
        activeAvgPriceUsd !== null
          ? terapeak.activeAvgPriceUsd !== null
            ? (terapeak.queryDebug.writeSources?.activeAvgPriceUsd ?? 'research_active')
            : 'ebay'
          : 'none',
      activeAvgShippingUsd:
        activeAvgShippingUsd !== null
          ? terapeak.activeAvgShippingUsd !== null
            ? (terapeak.queryDebug.writeSources?.activeAvgShippingUsd ?? 'research_active')
            : 'ebay'
          : 'none',
      activeListingsCount:
        activeListingsCount !== null
          ? isPresent(normalizedTerapeakActiveListingsCount)
            ? researchActiveListingsWriteSource
            : 'ebay'
          : 'none',
      activeAvgWatchersPerListing:
        activeAvgWatchersPerListing !== null
          ? terapeak.activeAvgWatchersPerListing !== null
            ? (terapeak.queryDebug.writeSources?.activeAvgWatchersPerListing ?? 'research_active')
            : 'ebay'
          : 'none',
      soldAvgPriceUsd:
        soldAvgPriceUsd !== null
          ? isPresent(normalizedTerapeakSoldAvgPriceUsd)
            ? (terapeak.queryDebug.writeSources?.soldAvgPriceUsd ??
              terapeak.queryDebug.writeSources?.researchSoldPriceUsd ??
              'research_sold')
            : 'sold'
          : 'none',
      soldMedianPriceUsd:
        soldMedianPriceUsd !== null
          ? terapeak.soldMedianPriceUsd !== null
            ? (terapeak.queryDebug.writeSources?.soldMedianPriceUsd ?? 'research_sold')
            : 'sold'
          : 'none',
      soldAvgShippingUsd:
        soldAvgShippingUsd !== null
          ? isPresent(normalizedTerapeakSoldAvgShippingUsd)
            ? (terapeak.queryDebug.writeSources?.soldAvgShippingUsd ?? 'research_sold')
            : 'none'
          : 'none',
      soldListingsCount:
        soldListingsCount !== null
          ? isPresent(terapeak.soldListingsCount)
            ? (terapeak.queryDebug.writeSources?.soldListingsCount ?? 'research_sold')
            : 'sold'
          : 'none',
      soldSellThroughPct:
        soldSellThroughPct !== null
          ? (terapeak.queryDebug.writeSources?.soldSellThroughPct ?? 'research_sold')
          : 'none',
      soldTotalRevenueUsd:
        soldTotalRevenueUsd !== null
          ? (terapeak.queryDebug.writeSources?.soldTotalRevenueUsd ?? 'research_sold')
          : 'none',
      marketPriceUsd: finalFieldSources.marketPriceUsd,
      avgShippingCostUsd: finalFieldSources.avgShippingCostUsd,
      competitionLevel: finalFieldSources.competitionLevel,
      twitterTrending: getWriteSource(social.twitterTrending, 'social'),
      youtubeViews24hMillions: getWriteSource(social.youtubeViews24hMillions, 'social'),
      redditPostsCount7d: getWriteSource(social.redditPostsCount7d, 'social'),
      day1Sold:
        day1Sold.source === 'terapeak'
          ? (terapeak.queryDebug.writeSources?.day1Sold ?? 'terapeak')
          : day1Sold.source,
      day2Sold:
        day2Sold.source === 'terapeak'
          ? (terapeak.queryDebug.writeSources?.day2Sold ?? 'terapeak')
          : day2Sold.source,
      day3Sold:
        day3Sold.source === 'terapeak'
          ? (terapeak.queryDebug.writeSources?.day3Sold ?? 'terapeak')
          : day3Sold.source,
      day4Sold:
        day4Sold.source === 'terapeak'
          ? (terapeak.queryDebug.writeSources?.day4Sold ?? 'terapeak')
          : day4Sold.source,
      day5Sold:
        day5Sold.source === 'terapeak'
          ? (terapeak.queryDebug.writeSources?.day5Sold ?? 'terapeak')
          : day5Sold.source,
      daysTracked:
        daysTracked.source === 'terapeak'
          ? (terapeak.queryDebug.writeSources?.daysTracked ?? 'terapeak')
          : daysTracked.source,
      previousPobAvgPriceUsd:
        terapeak.previousPobAvgPriceUsd !== null
          ? (terapeak.queryDebug.writeSources?.previousPobAvgPriceUsd ?? 'terapeak')
          : 'none',
      previousPobSellThroughPct:
        terapeak.previousPobSellThroughPct !== null
          ? (terapeak.queryDebug.writeSources?.previousPobSellThroughPct ?? 'terapeak')
          : 'none',
      previousComebackFirstWeekSales: getWriteSource(
        hasUsableHistoricalResearch ? research.previousComebackFirstWeekSales : null,
        'research'
      ),
      perplexityHistoricalContextScore: hasUsableHistoricalResearch ? 'research' : 'none',
      historicalContextNotes: hasUsableHistoricalResearch ? 'research' : 'none',
      researchConfidence: hasUsableHistoricalResearch ? 'research' : 'none',
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
        activeAvgPriceUsd,
        activeAvgShippingUsd,
        activeListingsCount,
        activeAvgWatchersPerListing,
        ...socialWrites,
        soldAvgPriceUsd,
        soldMedianPriceUsd,
        soldAvgShippingUsd,
        soldListingsCount,
        soldSellThroughPct,
        soldTotalRevenueUsd,
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
        sourceContext: effectiveRequest.sourceContext ?? null,
        effectiveSourceType: effectiveContext.sourceType,
        effectiveContextMode: effectiveContext.mode,
        effectiveSearchQuery: effectiveContext.effectiveSearchQuery,
        hasItem: effectiveContext.hasItem,
        hasEvent: effectiveContext.hasEvent,
        effectiveContext,
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
        finalFieldSources,
        providerResolution,
        sourceSet: ['ebay', 'sold', 'terapeak', 'social', 'chart', 'research'],
        providers: buildProviderDebug(
          effectiveRequest,
          ebay,
          sold,
          terapeak,
          social,
          chart,
          research
        ),
        queryContextUsed: requestQueryResolution.queryContextUsed,
        querySource: requestQueryResolution.querySource,
        resolvedSearchQuery: requestQueryResolution.resolvedSearchQuery,
        validationScope: requestQueryResolution.validationScope,
        queryScope: requestQueryResolution.queryScope,
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
