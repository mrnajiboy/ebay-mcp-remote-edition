import type { EbaySellerApi } from '@/api/index.js';
import { getValidationEffectiveContext } from '../effective-context.js';
import type {
  ResearchQueryDiagnostic,
  SoldBucketDebug,
  TerapeakValidationSignals,
  ValidationRunRequest,
  ValidationSoldVelocity,
} from '../types.js';
import {
  buildProviderQueryResolutionDebug,
  extractSemanticTokens,
  getUsableResolvedSearchQuery,
  hasExclusiveDirectQueryOverride,
  getPrimaryAlbumPhrase,
  sanitizeQueryCandidate,
} from './query-utils.js';
import {
  fetchEbayResearch,
  type EbayResearchResponse,
  type EbayResearchSoldRow,
} from './ebay-research.js';

interface ResearchQueryCandidate {
  family: string;
  query: string;
}

interface EvaluatedResearchCandidate {
  query: string;
  tier: number;
  family: string;
  response: EbayResearchResponse;
  activeListings: number | null;
  soldTotal: number | null;
  avgWatchersPerListing: number | null;
  watcherCoverageCount: number | null;
  sellThroughPct: number | null;
  titleMatchScore: number;
  subtypeAligned: boolean;
  score: number;
}

interface ResearchEvaluationOutcome {
  selected: EvaluatedResearchCandidate | null;
  diagnostics: ResearchQueryDiagnostic[];
  fallbackReasons: string[];
  firstResponse: EbayResearchResponse | null;
}

function isTerminalResearchAuthState(
  authState: EbayResearchResponse['debug']['authState'] | undefined
): boolean {
  return authState === 'missing' || authState === 'expired' || authState === 'unavailable';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildCompactPhrase(...parts: (string | null | undefined)[]): string {
  return sanitizeQueryCandidate(
    parts
      .map((part) => part?.trim() ?? '')
      .filter((part) => part.length > 0)
      .join(' ')
      .replace(/[,:;/\\|]+/g, ' ')
      .replace(/[-–—]+/g, ' ')
  );
}

function dedupeQueryPlan(candidates: ResearchQueryCandidate[]): ResearchQueryCandidate[] {
  const seen = new Set<string>();
  const result: ResearchQueryCandidate[] = [];

  for (const candidate of candidates) {
    const normalized = sanitizeQueryCandidate(candidate.query);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      family: candidate.family,
      query: normalized,
    });
  }

  return result;
}

function getValidationTypeClassification(
  request: ValidationRunRequest
): 'pob' | 'preorder' | 'standard' | 'other' {
  const normalizedValidationType = sanitizeQueryCandidate(
    request.validation.validationType
  ).toLowerCase();
  const normalizedValidationScope = sanitizeQueryCandidate(
    request.validation.queryContext?.validationScope ?? ''
  ).toLowerCase();
  const combined = `${normalizedValidationScope} ${normalizedValidationType}`.trim();

  if (/\bpob\b|benefit|photocard/.test(combined)) {
    return 'pob';
  }
  if (/pre\s*order|preorder/.test(combined)) {
    return 'preorder';
  }
  if (/\bstandard\b/.test(combined)) {
    return 'standard';
  }
  return 'other';
}

function getSubtypeToken(request: ValidationRunRequest): string | null {
  switch (getValidationTypeClassification(request)) {
    case 'pob':
      return 'POB';
    case 'preorder':
      return 'preorder';
    default:
      return null;
  }
}

function isAlbumScopedValidation(request: ValidationRunRequest): boolean {
  const validationScope = sanitizeQueryCandidate(
    request.validation.queryContext?.validationScope ?? ''
  ).toLowerCase();
  const queryScope = sanitizeQueryCandidate(
    request.validation.queryContext?.queryScope ?? ''
  ).toLowerCase();
  return validationScope.includes('album') || queryScope.includes('album');
}

function buildTitleQuery(request: ValidationRunRequest): string {
  return sanitizeQueryCandidate(request.item.name.replace(/\([^)]*\)/g, ' '));
}

function prependResolvedCandidate(
  request: ValidationRunRequest,
  fallbackPlan: ResearchQueryCandidate[]
): {
  queryPlan: ResearchQueryCandidate[];
  queryResolution: ReturnType<typeof buildProviderQueryResolutionDebug>;
} {
  const resolvedQuery = getUsableResolvedSearchQuery(request);
  const queryPlan = resolvedQuery
    ? hasExclusiveDirectQueryOverride(request)
      ? dedupeQueryPlan([{ family: 'resolved_query_context', query: resolvedQuery }])
      : dedupeQueryPlan([
          { family: 'resolved_query_context', query: resolvedQuery },
          ...fallbackPlan,
        ])
    : dedupeQueryPlan(fallbackPlan);

  return {
    queryPlan,
    queryResolution: buildProviderQueryResolutionDebug(request, resolvedQuery !== null),
  };
}

function buildCurrentResearchQueryPlan(request: ValidationRunRequest): {
  queryPlan: ResearchQueryCandidate[];
  queryResolution: ReturnType<typeof buildProviderQueryResolutionDebug>;
} {
  const effectiveContext = getValidationEffectiveContext(request);
  const primaryArtist = sanitizeQueryCandidate(
    effectiveContext.searchArtist ?? request.item.canonicalArtists[0] ?? ''
  );
  const albumPhrase = getPrimaryAlbumPhrase(request);
  const titleQuery = buildTitleQuery(request);
  const artistAlbumCore = buildCompactPhrase(primaryArtist, albumPhrase);
  const subtypeToken = getSubtypeToken(request);

  if (effectiveContext.sourceType === 'event') {
    return prependResolvedCandidate(request, [
      {
        family: 'artist_event_core',
        query: buildCompactPhrase(
          primaryArtist,
          effectiveContext.searchEvent,
          effectiveContext.searchItem
        ),
      },
      {
        family: 'event_location_fallback',
        query: buildCompactPhrase(effectiveContext.searchEvent, effectiveContext.searchLocation),
      },
      {
        family: 'event_only_fallback',
        query: buildCompactPhrase(effectiveContext.searchEvent),
      },
    ]);
  }

  if (isAlbumScopedValidation(request)) {
    const candidates: ResearchQueryCandidate[] = [
      { family: 'artist_album_core', query: artistAlbumCore },
      { family: 'normalized_title', query: buildCompactPhrase(primaryArtist, titleQuery) },
      { family: 'album_only_fallback', query: buildCompactPhrase(albumPhrase) },
    ];

    if (subtypeToken === 'POB') {
      candidates.splice(1, 0, {
        family: 'artist_album_pob',
        query: buildCompactPhrase(primaryArtist, albumPhrase, 'POB'),
      });
      candidates.splice(3, 0, {
        family: 'album_pob_fallback',
        query: buildCompactPhrase(albumPhrase, 'POB'),
      });
    } else if (subtypeToken === 'preorder') {
      candidates.splice(1, 0, {
        family: 'artist_album_preorder',
        query: buildCompactPhrase(primaryArtist, albumPhrase, 'preorder'),
      });
    }

    return prependResolvedCandidate(request, candidates);
  }

  return prependResolvedCandidate(request, [
    {
      family: 'artist_item_keyword',
      query: buildCompactPhrase(primaryArtist, effectiveContext.searchItem ?? request.item.name),
    },
    { family: 'artist_only', query: buildCompactPhrase(primaryArtist) },
    {
      family: 'item_only_fallback',
      query: buildCompactPhrase(effectiveContext.searchItem ?? request.item.name),
    },
  ]);
}

function buildPreviousPobResearchQueryPlan(request: ValidationRunRequest): {
  queryPlan: ResearchQueryCandidate[];
  queryResolution: ReturnType<typeof buildProviderQueryResolutionDebug>;
} {
  const effectiveContext = getValidationEffectiveContext(request);
  const primaryArtist = sanitizeQueryCandidate(
    effectiveContext.searchArtist ?? request.item.canonicalArtists[0] ?? ''
  );
  const albumPhrase = getPrimaryAlbumPhrase(request);
  const subtypeToken = getSubtypeToken(request);

  if (!isAlbumScopedValidation(request) || subtypeToken === null) {
    return {
      queryPlan: [],
      queryResolution: buildProviderQueryResolutionDebug(
        request,
        getUsableResolvedSearchQuery(request) !== null
      ),
    };
  }

  return prependResolvedCandidate(request, [
    {
      family: 'artist_album_subtype',
      query: buildCompactPhrase(primaryArtist, albumPhrase, subtypeToken),
    },
    {
      family: 'album_subtype_fallback',
      query: buildCompactPhrase(albumPhrase, subtypeToken),
    },
    {
      family: 'artist_album_core',
      query: buildCompactPhrase(primaryArtist, albumPhrase),
    },
    {
      family: 'album_only_fallback',
      query: buildCompactPhrase(albumPhrase),
    },
  ]);
}

function isSubtypeSpecificFamily(family: string): boolean {
  return [
    'artist_album_pob',
    'artist_album_preorder',
    'album_pob_fallback',
    'artist_album_subtype',
    'album_subtype_fallback',
  ].includes(family);
}

function getFamilyPreferenceBonus(family: string, mode: 'current_market' | 'previous_pob'): number {
  if (mode === 'previous_pob') {
    switch (family) {
      case 'artist_album_subtype':
        return 18;
      case 'album_subtype_fallback':
        return 14;
      case 'resolved_query_context':
        return 12;
      case 'artist_album_core':
        return 10;
      default:
        return 0;
    }
  }

  switch (family) {
    case 'resolved_query_context':
      return 18;
    case 'artist_album_core':
      return 16;
    case 'artist_item_keyword':
    case 'artist_event_core':
      return 14;
    case 'normalized_title':
      return 10;
    case 'artist_album_pob':
    case 'artist_album_preorder':
      return 6;
    case 'album_only_fallback':
    case 'item_only_fallback':
    case 'event_only_fallback':
      return 4;
    default:
      return 0;
  }
}

function getResearchTitles(response: EbayResearchResponse): string[] {
  return [
    ...response.active.listingRows.map((row) => row.title),
    ...response.sold.soldRows.map((row) => row.title),
  ].filter((title) => title.length > 0);
}

function computeTitleMatchScore(
  response: EbayResearchResponse,
  request: ValidationRunRequest
): number {
  const effectiveContext = getValidationEffectiveContext(request);
  const targetPhrase =
    effectiveContext.sourceType === 'event'
      ? buildCompactPhrase(
          effectiveContext.searchArtist,
          effectiveContext.searchEvent,
          effectiveContext.searchItem
        )
      : buildCompactPhrase(effectiveContext.searchArtist, getPrimaryAlbumPhrase(request));
  const coreTokens = extractSemanticTokens(targetPhrase);
  const titles = getResearchTitles(response);

  if (coreTokens.length === 0 || titles.length === 0) {
    return 0;
  }

  const scores = titles.map((title) => {
    const titleTokens = new Set(extractSemanticTokens(title));
    const matched = coreTokens.filter((token) => titleTokens.has(token)).length;
    return matched / coreTokens.length;
  });

  return round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

function computeSubtypeAlignment(
  response: EbayResearchResponse,
  request: ValidationRunRequest
): boolean {
  const subtypeToken = getSubtypeToken(request);
  if (!subtypeToken) {
    return false;
  }

  const normalizedSubtype = subtypeToken.toLowerCase();
  return getResearchTitles(response).some((title) =>
    title.toLowerCase().includes(normalizedSubtype)
  );
}

function getResearchActiveCount(response: EbayResearchResponse): number | null {
  return (
    response.active.totalActiveListings ??
    (response.active.listingRows.length > 0 ? response.active.listingRows.length : null)
  );
}

function getResearchSoldTotal(response: EbayResearchResponse): number | null {
  return (
    response.sold.totalSold ??
    (response.sold.soldRows.length > 0 ? response.sold.soldRows.length : null)
  );
}

function isUsefulResearchResponse(response: EbayResearchResponse): boolean {
  return (
    getResearchActiveCount(response) !== null ||
    getResearchSoldTotal(response) !== null ||
    response.active.avgWatchersPerListing !== null ||
    response.sold.sellThroughPct !== null
  );
}

function buildResearchQueryDiagnostic(
  evaluation: EvaluatedResearchCandidate,
  note?: string,
  tooNarrow = false
): ResearchQueryDiagnostic {
  return {
    query: evaluation.query,
    tier: evaluation.tier,
    family: evaluation.family,
    activeListings: evaluation.activeListings,
    soldTotal: evaluation.soldTotal,
    avgWatchersPerListing: evaluation.avgWatchersPerListing,
    watcherCoverageCount: evaluation.watcherCoverageCount,
    sellThroughPct: evaluation.sellThroughPct,
    titleMatchScore: evaluation.titleMatchScore,
    subtypeAligned: evaluation.subtypeAligned,
    tooNarrow,
    score: evaluation.score,
    status: 'ok',
    ...(note ? { note } : {}),
  };
}

function scoreResearchCandidate(
  response: EbayResearchResponse,
  request: ValidationRunRequest,
  family: string,
  mode: 'current_market' | 'previous_pob'
): Omit<EvaluatedResearchCandidate, 'query' | 'tier' | 'family' | 'response'> {
  const activeListings = getResearchActiveCount(response);
  const soldTotal = getResearchSoldTotal(response);
  const titleMatchScore = computeTitleMatchScore(response, request);
  const subtypeAligned = computeSubtypeAlignment(response, request);
  const watcherCoverageCount = response.active.watcherCoverageCount;
  const avgWatchersPerListing = response.active.avgWatchersPerListing;
  const sellThroughPct = response.sold.sellThroughPct;
  const score = round(
    Math.min(activeListings ?? 0, 25) * 1.6 +
      Math.min(soldTotal ?? 0, 25) * 2 +
      titleMatchScore * 30 +
      Math.min(watcherCoverageCount ?? 0, 8) * 1.5 +
      Math.min(avgWatchersPerListing ?? 0, 6) * 1.5 +
      Math.min((sellThroughPct ?? 0) / 5, 12) +
      getFamilyPreferenceBonus(family, mode) +
      (subtypeAligned ? 4 : 0)
  );

  return {
    activeListings,
    soldTotal,
    avgWatchersPerListing,
    watcherCoverageCount,
    sellThroughPct,
    titleMatchScore,
    subtypeAligned,
    score,
  };
}

function parseResearchSoldDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function bucketResearchSoldVelocity(
  soldRows: EbayResearchSoldRow[],
  requestTimestamp: string
): {
  soldVelocity: ValidationSoldVelocity;
  recentSoldCount7d: number | null;
  soldBucketDebug: SoldBucketDebug;
} {
  const requestDate = new Date(requestTimestamp);
  if (!Number.isFinite(requestDate.getTime())) {
    return {
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
        notes: ['bucketing skipped due to invalid request timestamp'],
        totalItemsExamined: soldRows.length,
        withSoldAt: 0,
        missingSoldAt: soldRows.length,
        dateParseFailures: 0,
        futureDated: 0,
        bucketedItems: 0,
      },
    };
  }

  const buckets = [0, 0, 0, 0, 0];
  let recentSoldCount7d = 0;
  let withSoldAt = 0;
  let missingSoldAt = 0;
  let dateParseFailures = 0;
  let futureDated = 0;
  let bucketedItems = 0;
  let maxTrackedDay = 0;

  for (const row of soldRows) {
    if (!row.lastSoldDate) {
      missingSoldAt += 1;
      continue;
    }

    const soldAt = parseResearchSoldDate(row.lastSoldDate);
    if (!soldAt) {
      dateParseFailures += 1;
      continue;
    }

    withSoldAt += 1;
    const soldDate = new Date(soldAt);
    if (soldDate.getTime() > requestDate.getTime()) {
      futureDated += 1;
      continue;
    }

    const diffDays = Math.floor(
      (requestDate.getTime() - soldDate.getTime()) / (24 * 60 * 60 * 1000)
    );
    if (diffDays >= 0 && diffDays < 7) {
      recentSoldCount7d += 1;
    }
    if (diffDays >= 0 && diffDays < 5) {
      buckets[diffDays] += 1;
      bucketedItems += 1;
      maxTrackedDay = Math.max(maxTrackedDay, diffDays + 1);
    }
  }

  const notes: string[] = [];
  if (missingSoldAt > 0) {
    notes.push(`sold date missing on ${missingSoldAt} research sold rows`);
  }
  if (dateParseFailures > 0) {
    notes.push(`sold date parsing failed on ${dateParseFailures} research sold rows`);
  }
  if (futureDated > 0) {
    notes.push(`ignored ${futureDated} future-dated research sold timestamps`);
  }

  return {
    soldVelocity: {
      day1Sold: buckets[0],
      day2Sold: buckets[1],
      day3Sold: buckets[2],
      day4Sold: buckets[3],
      day5Sold: buckets[4],
      daysTracked: maxTrackedDay > 0 ? maxTrackedDay : withSoldAt > 0 ? 5 : null,
    },
    recentSoldCount7d,
    soldBucketDebug: {
      status: withSoldAt === 0 ? 'skipped' : notes.length > 0 ? 'partial' : 'ok',
      notes,
      totalItemsExamined: soldRows.length,
      withSoldAt,
      missingSoldAt,
      dateParseFailures,
      futureDated,
      bucketedItems,
    },
  };
}

async function evaluateResearchCandidates(
  queryPlan: ResearchQueryCandidate[],
  request: ValidationRunRequest,
  mode: 'current_market' | 'previous_pob'
): Promise<ResearchEvaluationOutcome> {
  const diagnostics: ResearchQueryDiagnostic[] = [];
  const evaluated: EvaluatedResearchCandidate[] = [];
  const fallbackReasons: string[] = [];
  let firstResponse: EbayResearchResponse | null = null;

  for (const [index, candidate] of queryPlan.entries()) {
    try {
      const response = await fetchEbayResearch(candidate.query);
      firstResponse ??= response;
      const evaluation: EvaluatedResearchCandidate = {
        query: candidate.query,
        tier: index + 1,
        family: candidate.family,
        response,
        ...scoreResearchCandidate(response, request, candidate.family, mode),
      };

      diagnostics.push(buildResearchQueryDiagnostic(evaluation));
      if (isUsefulResearchResponse(response)) {
        evaluated.push(evaluation);
        continue;
      }

      if (isTerminalResearchAuthState(response.debug.authState)) {
        fallbackReasons.push(
          response.debug.notes[0] ??
            'Authenticated eBay Research session is unavailable, so additional research candidates were skipped.'
        );
        break;
      }
    } catch (error) {
      diagnostics.push({
        query: candidate.query,
        tier: index + 1,
        family: candidate.family,
        activeListings: null,
        soldTotal: null,
        avgWatchersPerListing: null,
        watcherCoverageCount: null,
        sellThroughPct: null,
        titleMatchScore: null,
        score: null,
        status: 'error',
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (evaluated.length === 0) {
    fallbackReasons.push(
      'No evaluated eBay Research candidate returned useful ACTIVE or SOLD data.'
    );
    return {
      selected: null,
      diagnostics,
      fallbackReasons,
      firstResponse,
    };
  }

  evaluated.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.tier - right.tier;
  });

  let selected = evaluated[0] ?? null;
  const broadCandidate =
    evaluated.find((candidate) => !isSubtypeSpecificFamily(candidate.family)) ?? null;
  const subtypeCandidate =
    evaluated.find((candidate) => isSubtypeSpecificFamily(candidate.family)) ?? null;

  if (
    mode === 'current_market' &&
    selected !== null &&
    broadCandidate !== null &&
    subtypeCandidate !== null &&
    subtypeCandidate.query !== broadCandidate.query &&
    (subtypeCandidate.activeListings ?? 0) < (broadCandidate.activeListings ?? 0) * 0.5 &&
    (subtypeCandidate.soldTotal ?? 0) < (broadCandidate.soldTotal ?? 0) * 0.7 &&
    broadCandidate.titleMatchScore >= subtypeCandidate.titleMatchScore - 0.1
  ) {
    selected = broadCandidate;
    fallbackReasons.push(
      'Subtype-specific research query underfired relative to broader album-market coverage, so the broader query was preferred for current-market context.'
    );
  }

  if (
    mode === 'previous_pob' &&
    subtypeCandidate !== null &&
    ((subtypeCandidate.soldTotal ?? 0) > 0 || subtypeCandidate.sellThroughPct !== null)
  ) {
    selected = subtypeCandidate;
  }

  return {
    selected,
    diagnostics: diagnostics.map((diagnostic) => {
      if (
        selected?.query === broadCandidate?.query &&
        subtypeCandidate !== null &&
        diagnostic.query === subtypeCandidate.query
      ) {
        return {
          ...diagnostic,
          tooNarrow: true,
          note:
            diagnostic.note ??
            'Subtype-specific candidate was evaluated but treated as too narrow relative to broader album-market coverage.',
        };
      }

      return diagnostic;
    }),
    fallbackReasons,
    firstResponse,
  };
}

function determineConfidence(input: {
  currentHasActive: boolean;
  currentHasSold: boolean;
  previousHasSold: boolean;
  currentWatcherCoverage: number | null;
}): TerapeakValidationSignals['confidence'] {
  if (
    input.currentHasActive &&
    input.currentHasSold &&
    input.previousHasSold &&
    (input.currentWatcherCoverage ?? 0) >= 3
  ) {
    return 'High';
  }

  if (input.currentHasActive || input.currentHasSold || input.previousHasSold) {
    return 'Medium';
  }

  return 'Low';
}

export async function getTerapeakValidationSignals(
  _api: EbaySellerApi,
  request: ValidationRunRequest
): Promise<TerapeakValidationSignals> {
  const currentPlan = buildCurrentResearchQueryPlan(request);
  const previousPlan = buildPreviousPobResearchQueryPlan(request);
  const currentQuery = currentPlan.queryPlan[0]?.query ?? null;
  const previousPobQuery = previousPlan.queryPlan[0]?.query ?? null;
  const emptySoldVelocity: ValidationSoldVelocity = {
    day1Sold: null,
    day2Sold: null,
    day3Sold: null,
    day4Sold: null,
    day5Sold: null,
    daysTracked: null,
  };
  const emptySoldBucketDebug: SoldBucketDebug = {
    status: 'skipped',
    notes: ['research sold bucketing did not run'],
    totalItemsExamined: 0,
    withSoldAt: 0,
    missingSoldAt: 0,
    dateParseFailures: 0,
    futureDated: 0,
    bucketedItems: 0,
  };

  if (!currentQuery) {
    return {
      avgWatchersPerListing: null,
      preOrderListingsCount: null,
      marketPriceUsd: null,
      researchSoldPriceUsd: null,
      avgShippingCostUsd: null,
      competitionLevel: null,
      previousPobAvgPriceUsd: null,
      previousPobSellThroughPct: null,
      currentListingsCount: null,
      soldListingsCount: null,
      soldVelocity: emptySoldVelocity,
      recentSoldCount7d: null,
      soldBucketDebug: emptySoldBucketDebug,
      provider: 'none',
      confidence: 'Low',
      queryDebug: {
        currentQuery,
        previousPobQuery,
        currentQueryFamily: null,
        previousPobQueryFamily: null,
        selectedMode: 'combined',
        currentResultCount: null,
        previousPobResultCount: null,
        queryResolution: currentPlan.queryResolution,
        candidateDiagnostics: [],
        previousPobCandidateDiagnostics: [],
        fallbackReasons: [
          'No research query candidates were available for authenticated eBay Research evaluation.',
        ],
        writeSources: {},
        notes:
          'No research query candidates were available for authenticated eBay Research evaluation.',
      },
    };
  }

  try {
    const currentOutcome = await evaluateResearchCandidates(
      currentPlan.queryPlan,
      request,
      'current_market'
    );
    const previousOutcome = previousPlan.queryPlan.length
      ? await evaluateResearchCandidates(previousPlan.queryPlan, request, 'previous_pob')
      : { selected: null, diagnostics: [], fallbackReasons: [], firstResponse: null };
    const currentSelected = currentOutcome.selected;
    const previousSelected = previousOutcome.selected;
    const currentAttemptedResearch = currentSelected?.response ?? currentOutcome.firstResponse;
    const previousPobResearch = previousSelected?.response ?? previousOutcome.firstResponse;
    const previousHasSold =
      previousPobResearch !== null &&
      (previousPobResearch.sold.totalSold !== null || previousPobResearch.sold.soldRows.length > 0);

    if (!currentSelected) {
      return {
        avgWatchersPerListing: null,
        preOrderListingsCount: null,
        marketPriceUsd: null,
        researchSoldPriceUsd: null,
        avgShippingCostUsd: null,
        competitionLevel: null,
        previousPobAvgPriceUsd: previousPobResearch?.sold.avgSoldPriceUsd ?? null,
        previousPobSellThroughPct: previousPobResearch?.sold.sellThroughPct ?? null,
        currentListingsCount: null,
        soldListingsCount: null,
        soldVelocity: emptySoldVelocity,
        recentSoldCount7d: null,
        soldBucketDebug: emptySoldBucketDebug,
        provider: currentAttemptedResearch || previousPobResearch ? 'ebay_research_ui' : 'none',
        confidence: determineConfidence({
          currentHasActive: false,
          currentHasSold: false,
          previousHasSold,
          currentWatcherCoverage: null,
        }),
        queryDebug: {
          currentQuery,
          previousPobQuery,
          currentQueryFamily: null,
          previousPobQueryFamily: previousSelected?.family ?? null,
          selectedMode: previousSelected ? 'combined' : 'current_market',
          currentResultCount: null,
          previousPobResultCount:
            previousSelected !== null
              ? Math.max(previousSelected.activeListings ?? 0, previousSelected.soldTotal ?? 0)
              : null,
          queryResolution: currentPlan.queryResolution,
          currentModulesSeen: currentAttemptedResearch?.debug.modulesSeen,
          previousPobModulesSeen: previousPobResearch?.debug.modulesSeen,
          currentPageErrors: currentAttemptedResearch?.debug.pageErrors,
          previousPobPageErrors: previousPobResearch?.debug.pageErrors,
          currentActiveEndpointUrl: currentAttemptedResearch?.debug.activeEndpointUrl,
          currentSoldEndpointUrl: currentAttemptedResearch?.debug.soldEndpointUrl,
          previousPobActiveEndpointUrl: previousPobResearch?.debug.activeEndpointUrl,
          previousPobSoldEndpointUrl: previousPobResearch?.debug.soldEndpointUrl,
          authState: currentAttemptedResearch?.debug.authState,
          sessionStrategy: currentAttemptedResearch?.debug.sessionStrategy,
          sessionSource: currentAttemptedResearch?.debug.sessionSource,
          kvLoadAttempted: currentAttemptedResearch?.debug.kvLoadAttempted,
          kvLoadSucceeded: currentAttemptedResearch?.debug.kvLoadSucceeded,
          envLoadAttempted: currentAttemptedResearch?.debug.envLoadAttempted,
          envLoadSucceeded: currentAttemptedResearch?.debug.envLoadSucceeded,
          filesystemLoadAttempted: currentAttemptedResearch?.debug.filesystemLoadAttempted,
          filesystemLoadSucceeded: currentAttemptedResearch?.debug.filesystemLoadSucceeded,
          profileLoadAttempted: currentAttemptedResearch?.debug.profileLoadAttempted,
          profileLoadSucceeded: currentAttemptedResearch?.debug.profileLoadSucceeded,
          candidateDiagnostics: currentOutcome.diagnostics,
          previousPobCandidateDiagnostics: previousOutcome.diagnostics,
          fallbackReasons: currentOutcome.fallbackReasons,
          writeSources: {
            previousPobAvgPriceUsd:
              previousPobResearch?.sold.avgSoldPriceUsd !== null
                ? 'research_previous_pob_sold'
                : 'none',
            previousPobSellThroughPct:
              previousPobResearch?.sold.sellThroughPct !== null
                ? 'research_previous_pob_sold'
                : 'none',
          },
          notes: [
            ...(currentAttemptedResearch?.debug.notes ?? []),
            ...(previousPobResearch?.debug.notes ?? []),
            previousPobResearch
              ? 'No useful authenticated eBay Research candidate could be selected for current-market validation, but previous-POB research signals were preserved.'
              : 'No useful authenticated eBay Research candidate could be selected for current-market validation.',
          ]
            .filter((entry) => entry.length > 0)
            .join(' '),
        },
      };
    }

    const currentResearch = currentSelected.response;
    const researchVelocity = bucketResearchSoldVelocity(
      currentResearch.sold.soldRows,
      request.timestamp
    );

    const currentHasActive =
      currentResearch.active.totalActiveListings !== null ||
      currentResearch.active.listingRows.length > 0;
    const currentHasSold =
      currentResearch.sold.totalSold !== null || currentResearch.sold.soldRows.length > 0;
    const confidence = determineConfidence({
      currentHasActive,
      currentHasSold,
      previousHasSold,
      currentWatcherCoverage: currentResearch.active.watcherCoverageCount,
    });
    const currentResultCount = Math.max(
      currentSelected.activeListings ?? 0,
      currentSelected.soldTotal ?? 0,
      currentResearch.active.listingRows.length,
      currentResearch.sold.soldRows.length
    );
    const previousPobResultCount = previousPobResearch
      ? Math.max(
          previousSelected?.activeListings ?? 0,
          previousSelected?.soldTotal ?? 0,
          previousPobResearch.active.listingRows.length,
          previousPobResearch.sold.soldRows.length
        )
      : null;
    const writeSources: Record<string, string> = {
      avgWatchersPerListing:
        currentResearch.active.avgWatchersPerListing !== null ? 'research_active' : 'none',
      preOrderListingsCount:
        currentResearch.active.totalActiveListings !== null ? 'research_active' : 'none',
      competitionLevel:
        currentResearch.active.totalActiveListings !== null ? 'research_active' : 'none',
      avgShippingCostUsd:
        currentResearch.sold.avgShippingUsd !== null
          ? 'research_sold_avg_shipping'
          : currentResearch.active.avgShippingUsd !== null
            ? 'research_active_avg_shipping'
            : 'none',
      marketPriceUsd:
        currentResearch.sold.avgSoldPriceUsd !== null
          ? 'research_sold_avg'
          : currentResearch.active.avgListingPriceUsd !== null
            ? 'research_active_avg_listing'
            : 'none',
      previousPobAvgPriceUsd:
        previousPobResearch?.sold.avgSoldPriceUsd !== null ? 'research_previous_pob_sold' : 'none',
      previousPobSellThroughPct:
        previousPobResearch?.sold.sellThroughPct !== null ? 'research_previous_pob_sold' : 'none',
      day1Sold: researchVelocity.soldVelocity.day1Sold !== null ? 'research_sold_rows' : 'none',
      day2Sold: researchVelocity.soldVelocity.day2Sold !== null ? 'research_sold_rows' : 'none',
      day3Sold: researchVelocity.soldVelocity.day3Sold !== null ? 'research_sold_rows' : 'none',
      day4Sold: researchVelocity.soldVelocity.day4Sold !== null ? 'research_sold_rows' : 'none',
      day5Sold: researchVelocity.soldVelocity.day5Sold !== null ? 'research_sold_rows' : 'none',
      daysTracked:
        researchVelocity.soldVelocity.daysTracked !== null ? 'research_sold_rows' : 'none',
    };

    return {
      avgWatchersPerListing: currentResearch.active.avgWatchersPerListing,
      preOrderListingsCount: currentResearch.active.totalActiveListings,
      marketPriceUsd:
        currentResearch.sold.avgSoldPriceUsd ?? currentResearch.active.avgListingPriceUsd ?? null,
      researchSoldPriceUsd: currentResearch.sold.avgSoldPriceUsd ?? null,
      avgShippingCostUsd:
        currentResearch.sold.avgShippingUsd ?? currentResearch.active.avgShippingUsd ?? null,
      competitionLevel: currentResearch.active.totalActiveListings,
      previousPobAvgPriceUsd: previousPobResearch?.sold.avgSoldPriceUsd ?? null,
      previousPobSellThroughPct: previousPobResearch?.sold.sellThroughPct ?? null,
      currentListingsCount: currentResearch.active.totalActiveListings,
      soldListingsCount: currentResearch.sold.totalSold,
      soldVelocity: researchVelocity.soldVelocity,
      recentSoldCount7d: researchVelocity.recentSoldCount7d,
      soldBucketDebug: researchVelocity.soldBucketDebug,
      provider: 'ebay_research_ui',
      confidence,
      queryDebug: {
        currentQuery: currentSelected.query,
        previousPobQuery: previousSelected?.query ?? previousPobQuery,
        currentQueryFamily: currentSelected.family,
        previousPobQueryFamily: previousSelected?.family ?? null,
        selectedMode: previousPobQuery ? 'combined' : 'current_market',
        currentResultCount,
        previousPobResultCount,
        queryResolution: currentPlan.queryResolution,
        currentModulesSeen: currentResearch.debug.modulesSeen,
        previousPobModulesSeen: previousPobResearch?.debug.modulesSeen,
        currentPageErrors: currentResearch.debug.pageErrors,
        previousPobPageErrors: previousPobResearch?.debug.pageErrors,
        currentActiveEndpointUrl: currentResearch.debug.activeEndpointUrl,
        currentSoldEndpointUrl: currentResearch.debug.soldEndpointUrl,
        previousPobActiveEndpointUrl: previousPobResearch?.debug.activeEndpointUrl,
        previousPobSoldEndpointUrl: previousPobResearch?.debug.soldEndpointUrl,
        authState: currentResearch.debug.authState,
        sessionStrategy: currentResearch.debug.sessionStrategy,
        sessionSource: currentResearch.debug.sessionSource,
        kvLoadAttempted: currentResearch.debug.kvLoadAttempted,
        kvLoadSucceeded: currentResearch.debug.kvLoadSucceeded,
        envLoadAttempted: currentResearch.debug.envLoadAttempted,
        envLoadSucceeded: currentResearch.debug.envLoadSucceeded,
        filesystemLoadAttempted: currentResearch.debug.filesystemLoadAttempted,
        filesystemLoadSucceeded: currentResearch.debug.filesystemLoadSucceeded,
        profileLoadAttempted: currentResearch.debug.profileLoadAttempted,
        profileLoadSucceeded: currentResearch.debug.profileLoadSucceeded,
        candidateDiagnostics: currentOutcome.diagnostics,
        previousPobCandidateDiagnostics: previousOutcome.diagnostics,
        currentWatcherCoverageCount: currentResearch.active.watcherCoverageCount,
        previousPobWatcherCoverageCount: previousPobResearch?.active.watcherCoverageCount ?? null,
        fallbackReasons: [...currentOutcome.fallbackReasons, ...previousOutcome.fallbackReasons],
        writeSources,
        notes: [
          ...currentResearch.debug.notes,
          ...(previousPobResearch?.debug.notes ?? []),
          `Selected current-market research query family ${currentSelected.family}.`,
          previousSelected
            ? `Selected previous-market research query family ${previousSelected.family}.`
            : 'No separate previous-market research candidate was selected.',
          previousPobQuery
            ? 'Authenticated eBay Research provider evaluated both current-market and previous-POB query candidates.'
            : 'Authenticated eBay Research provider evaluated the current-market query candidate only.',
        ]
          .filter((entry) => entry.length > 0)
          .join(' '),
      },
    };
  } catch (error) {
    return {
      avgWatchersPerListing: null,
      preOrderListingsCount: null,
      marketPriceUsd: null,
      researchSoldPriceUsd: null,
      avgShippingCostUsd: null,
      competitionLevel: null,
      previousPobAvgPriceUsd: null,
      previousPobSellThroughPct: null,
      currentListingsCount: null,
      soldListingsCount: null,
      soldVelocity: emptySoldVelocity,
      recentSoldCount7d: null,
      soldBucketDebug: emptySoldBucketDebug,
      provider: 'none',
      confidence: 'Low',
      queryDebug: {
        currentQuery,
        previousPobQuery,
        currentQueryFamily: null,
        previousPobQueryFamily: null,
        selectedMode: previousPobQuery ? 'combined' : 'current_market',
        currentResultCount: null,
        previousPobResultCount: null,
        queryResolution: currentPlan.queryResolution,
        candidateDiagnostics: [],
        previousPobCandidateDiagnostics: [],
        fallbackReasons: [],
        writeSources: {},
        notes:
          error instanceof Error
            ? error.message
            : 'Authenticated eBay Research retrieval failed before any normalized response could be produced.',
      },
    };
  }
}
