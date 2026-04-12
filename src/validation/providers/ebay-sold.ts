import axios from 'axios';
import type {
  EbaySoldValidationSignals,
  SoldBucketDebug,
  SoldQueryDiagnostic,
  SoldItemSample,
  ValidationRunRequest,
  ValidationSignalConfidence,
  ValidationSoldVelocity,
} from '../types.js';
import {
  buildResolvedSoldQueryPlan,
  extractSemanticTokens,
  getPrimaryAlbumPhrase,
  sanitizeQueryCandidate,
} from './query-utils.js';

interface SoldProviderProduct {
  title?: string;
  sale_price?: number | string;
  date_sold?: string;
  link?: string;
}

interface SoldProviderResponse {
  success?: boolean;
  average_price?: number;
  median_price?: number;
  min_price?: number;
  max_price?: number;
  results?: number;
  response_url?: string;
  products?: SoldProviderProduct[];
}

interface NormalizedSoldProducts {
  allItems: SoldItemSample[];
  soldItemsSample: SoldItemSample[];
  totalItemsExamined: number;
  withSoldAt: number;
  missingSoldAt: number;
  dateParseFailures: number;
}

interface BucketSoldVelocityResult {
  soldVelocity: ValidationSoldVelocity;
  recentSoldCount7d: number;
  soldBucketDebug: SoldBucketDebug;
}

interface SoldCandidateEvaluation {
  query: string;
  tier: number;
  family?: string;
  soldResultsCount: number | null;
  recentSoldCount7d: number;
  titleMatchScore: number;
  subtypeAligned: boolean;
  confidence: ValidationSignalConfidence;
  soldAveragePriceUsd: number | null;
  soldMedianPriceUsd: number | null;
  soldMinPriceUsd: number | null;
  soldMaxPriceUsd: number | null;
  soldItemsSample: SoldItemSample[];
  soldVelocity: ValidationSoldVelocity;
  soldBucketDebug: SoldBucketDebug;
  responseUrl: string | null;
  status: 'ok' | 'error';
  querySelectionScore: number;
}

const MAX_SOLD_QUERY_EVALUATIONS = 4;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizePrice(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return round(value);
  }

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]+/g, ''));
    if (Number.isFinite(parsed)) {
      return round(parsed);
    }
  }

  return null;
}

function parseSoldDate(value: string | undefined): {
  soldAt: string | null;
  state: 'ok' | 'missing' | 'invalid';
} {
  if (!value) {
    return {
      soldAt: null,
      state: 'missing',
    };
  }

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) {
    return {
      soldAt: parsed.toISOString(),
      state: 'ok',
    };
  }

  return {
    soldAt: null,
    state: 'invalid',
  };
}

function normalizeProducts(products: SoldProviderProduct[] | undefined): NormalizedSoldProducts {
  const allItems: SoldItemSample[] = [];
  let withSoldAt = 0;
  let missingSoldAt = 0;
  let dateParseFailures = 0;

  for (const product of products ?? []) {
    const soldDate = parseSoldDate(product.date_sold);
    if (soldDate.state === 'ok') {
      withSoldAt += 1;
    } else if (soldDate.state === 'missing') {
      missingSoldAt += 1;
    } else {
      dateParseFailures += 1;
    }

    allItems.push({
      title: product.title?.trim() ?? 'Untitled sold listing',
      soldAt: soldDate.soldAt,
      priceUsd: normalizePrice(product.sale_price),
      itemUrl: typeof product.link === 'string' ? product.link : null,
    });
  }

  return {
    allItems,
    soldItemsSample: allItems.slice(0, 10),
    totalItemsExamined: allItems.length,
    withSoldAt,
    missingSoldAt,
    dateParseFailures,
  };
}

function bucketSoldVelocity(
  soldItems: SoldItemSample[],
  normalizedProducts: NormalizedSoldProducts,
  requestTimestamp: string
): BucketSoldVelocityResult {
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
      recentSoldCount7d: 0,
      soldBucketDebug: {
        status: 'skipped',
        notes: ['bucketing skipped due to invalid request timestamp'],
        totalItemsExamined: normalizedProducts.totalItemsExamined,
        withSoldAt: normalizedProducts.withSoldAt,
        missingSoldAt: normalizedProducts.missingSoldAt,
        dateParseFailures: normalizedProducts.dateParseFailures,
        futureDated: 0,
        bucketedItems: 0,
      },
    };
  }

  const buckets = [0, 0, 0, 0, 0];
  let maxTrackedDay = 0;
  let recentSoldCount7d = 0;
  let futureDated = 0;
  let bucketedItems = 0;

  for (const item of soldItems) {
    if (!item.soldAt) {
      continue;
    }

    const soldDate = new Date(item.soldAt);
    if (!Number.isFinite(soldDate.getTime()) || soldDate.getTime() > requestDate.getTime()) {
      if (Number.isFinite(soldDate.getTime()) && soldDate.getTime() > requestDate.getTime()) {
        futureDated += 1;
      }
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
  if (normalizedProducts.missingSoldAt > 0) {
    notes.push(`soldAt missing on ${normalizedProducts.missingSoldAt} sold records`);
  }
  if (normalizedProducts.dateParseFailures > 0) {
    notes.push(`date parse failed on ${normalizedProducts.dateParseFailures} sold records`);
  }
  if (futureDated > 0) {
    notes.push(`ignored ${futureDated} future-dated sold timestamps`);
  }
  if (
    normalizedProducts.withSoldAt === 0 &&
    (normalizedProducts.missingSoldAt > 0 || normalizedProducts.dateParseFailures > 0)
  ) {
    notes.push('bucketing skipped due to provider timestamp quality');
  }

  const status: SoldBucketDebug['status'] =
    normalizedProducts.withSoldAt === 0 && notes.length > 0
      ? 'skipped'
      : notes.length > 0
        ? 'partial'
        : 'ok';

  return {
    soldVelocity: {
      day1Sold: buckets[0],
      day2Sold: buckets[1],
      day3Sold: buckets[2],
      day4Sold: buckets[3],
      day5Sold: buckets[4],
      daysTracked: maxTrackedDay > 0 ? maxTrackedDay : normalizedProducts.withSoldAt > 0 ? 5 : null,
    },
    recentSoldCount7d,
    soldBucketDebug: {
      status,
      notes,
      totalItemsExamined: normalizedProducts.totalItemsExamined,
      withSoldAt: normalizedProducts.withSoldAt,
      missingSoldAt: normalizedProducts.missingSoldAt,
      dateParseFailures: normalizedProducts.dateParseFailures,
      futureDated,
      bucketedItems,
    },
  };
}

function getPrimaryArtist(request: ValidationRunRequest): string {
  return sanitizeQueryCandidate(request.item.canonicalArtists[0] ?? '');
}

function getSubtypeToken(request: ValidationRunRequest): string | null {
  const validationType = sanitizeQueryCandidate(request.validation.validationType).toLowerCase();
  const validationScope = sanitizeQueryCandidate(
    request.validation.queryContext?.validationScope ?? ''
  ).toLowerCase();
  const combined = `${validationScope} ${validationType}`.trim();

  if (/\bpob\b|benefit|photocard/.test(combined)) {
    return 'pob';
  }

  if (/pre\s*order|preorder/.test(combined)) {
    return 'preorder';
  }

  return null;
}

function buildBroadAlbumQuery(request: ValidationRunRequest): string | null {
  const primaryArtist = getPrimaryArtist(request);
  const albumPhrase = getPrimaryAlbumPhrase(request);
  const query = sanitizeQueryCandidate(`${primaryArtist} ${albumPhrase}`);
  return query || null;
}

function buildSubtypeSpecificQuery(request: ValidationRunRequest): string | null {
  const subtypeToken = getSubtypeToken(request);
  if (!subtypeToken) {
    return null;
  }

  const primaryArtist = getPrimaryArtist(request);
  const albumPhrase = getPrimaryAlbumPhrase(request);
  const query = sanitizeQueryCandidate(`${primaryArtist} ${albumPhrase} ${subtypeToken}`);
  return query || null;
}

function computeTitleMatchScore(
  soldItems: SoldItemSample[],
  request: ValidationRunRequest
): number {
  const coreTokens = extractSemanticTokens(
    `${getPrimaryArtist(request)} ${getPrimaryAlbumPhrase(request)}`
  );

  if (coreTokens.length === 0 || soldItems.length === 0) {
    return 0;
  }

  const scores = soldItems.map((item) => {
    const titleTokens = new Set(extractSemanticTokens(item.title));
    const matchedTokens = coreTokens.filter((token) => titleTokens.has(token)).length;
    return matchedTokens / coreTokens.length;
  });

  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function computeSubtypeAlignment(
  soldItems: SoldItemSample[],
  request: ValidationRunRequest
): boolean {
  const subtypeToken = getSubtypeToken(request);
  if (!subtypeToken || soldItems.length === 0) {
    return false;
  }

  const normalizedSubtypeToken = subtypeToken.toLowerCase();
  return soldItems.some((item) => item.title.toLowerCase().includes(normalizedSubtypeToken));
}

function getFamilyPreferenceBonus(family: string | undefined): number {
  switch (family) {
    case 'resolved_query_context':
      return 18;
    case 'artist_album_core':
      return 16;
    case 'artist_album_subtype':
    case 'artist_album_validation_type':
      return 14;
    case 'artist_title_listing':
      return 10;
    case 'album_subtype_only':
    case 'album_descriptor_only':
      return 6;
    case 'album_only_fallback':
      return 4;
    default:
      return 0;
  }
}

function isSubtypeSpecificFamily(family: string | undefined): boolean {
  return family === 'artist_album_subtype' || family === 'album_subtype_only';
}

function pushEvaluationIndex(indices: number[], index: number | null): void {
  if (index === null || index < 0 || indices.includes(index)) {
    return;
  }

  indices.push(index);
}

function buildSoldEvaluationOrder(
  queryPlan: { family: string; query: string }[],
  broadAlbumQuery: string | null,
  subtypeSpecificQuery: string | null
): number[] {
  const indices: number[] = [];
  const findIndex = (
    predicate: (candidate: { family: string; query: string }) => boolean
  ): number | null => {
    const index = queryPlan.findIndex(predicate);
    return index >= 0 ? index : null;
  };

  pushEvaluationIndex(indices, 0);
  pushEvaluationIndex(
    indices,
    findIndex((candidate) => candidate.family === 'resolved_query_context')
  );
  pushEvaluationIndex(
    indices,
    findIndex(
      (candidate) =>
        candidate.family === 'artist_album_core' ||
        (broadAlbumQuery !== null &&
          candidate.query.toLowerCase() === broadAlbumQuery.toLowerCase())
    )
  );
  pushEvaluationIndex(
    indices,
    findIndex(
      (candidate) =>
        isSubtypeSpecificFamily(candidate.family) ||
        (subtypeSpecificQuery !== null &&
          candidate.query.toLowerCase() === subtypeSpecificQuery.toLowerCase())
    )
  );
  pushEvaluationIndex(
    indices,
    findIndex((candidate) => candidate.family === 'artist_album_descriptor')
  );
  pushEvaluationIndex(
    indices,
    findIndex((candidate) => candidate.family === 'artist_album_validation_type')
  );
  pushEvaluationIndex(
    indices,
    findIndex((candidate) => candidate.family === 'artist_title_listing')
  );
  pushEvaluationIndex(
    indices,
    findIndex((candidate) => candidate.family === 'album_only_fallback')
  );

  for (
    let index = 0;
    index < queryPlan.length && indices.length < MAX_SOLD_QUERY_EVALUATIONS;
    index += 1
  ) {
    pushEvaluationIndex(indices, index);
  }

  return indices.slice(0, MAX_SOLD_QUERY_EVALUATIONS);
}

function buildSelectionReason(
  selectedCandidate: SoldCandidateEvaluation,
  broadAlbumCandidate: SoldCandidateEvaluation | null,
  subtypeCandidate: SoldCandidateEvaluation | null,
  subtypeDiagnostic: SoldQueryDiagnostic | undefined
): string {
  if (
    selectedCandidate.query === broadAlbumCandidate?.query &&
    subtypeCandidate &&
    subtypeCandidate.query !== broadAlbumCandidate.query &&
    (subtypeDiagnostic?.tooNarrow ?? false)
  ) {
    return 'Selected broader album-core sold query because subtype-specific coverage was materially weaker while album-title relevance remained strong.';
  }

  if (selectedCandidate.recentSoldCount7d > 0) {
    return 'Selected sold query because it combined the strongest relevant sold coverage with recent transaction activity.';
  }

  if (selectedCandidate.soldResultsCount && selectedCandidate.soldResultsCount > 0) {
    return 'Selected sold query because it provided the strongest relevant sold sample among evaluated album-market candidates.';
  }

  return 'Selected highest-priority sold candidate after all evaluated options returned weak or zero sold coverage.';
}

function scoreSoldConfidence(
  soldResultsCount: number | null,
  soldItemsSample: SoldItemSample[]
): ValidationSignalConfidence {
  const datedItems = soldItemsSample.filter((item) => item.soldAt !== null).length;

  if ((soldResultsCount ?? 0) >= 20 && datedItems >= 3) {
    return 'High';
  }
  if ((soldResultsCount ?? 0) >= 8) {
    return 'Medium';
  }
  return 'Low';
}

function createEmptySoldSignals(
  query: string | null,
  queryCandidates: string[] = [],
  status: EbaySoldValidationSignals['status'],
  errorMessage?: string
): EbaySoldValidationSignals {
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
      notes: ['sold bucketing did not run'],
      totalItemsExamined: 0,
      withSoldAt: 0,
      missingSoldAt: 0,
      dateParseFailures: 0,
      futureDated: 0,
      bucketedItems: 0,
    },
    query,
    queryCandidates,
    selectedQuery: query ?? undefined,
    selectedQueryTier: query ? 1 : null,
    selectedQueryFamily: null,
    broadAlbumQuery: null,
    subtypeSpecificQuery: null,
    querySelectionReason: query
      ? 'No sold candidate evaluation completed; returning fallback query for traceability.'
      : 'No sold query candidates were available.',
    responseUrl: null,
    status,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export async function getEbaySoldValidationSignals(
  request: ValidationRunRequest
): Promise<EbaySoldValidationSignals> {
  const soldApiUrl = process.env.SOLD_ITEMS_API_URL?.trim();
  const soldApiKey = process.env.SOLD_ITEMS_API_KEY?.trim();
  const { queryPlan, queryResolution } = buildResolvedSoldQueryPlan(request);
  const queryCandidates = queryPlan.map((candidate) => candidate.query);
  const query = queryCandidates[0] ?? null;
  const queryDiagnostics: SoldQueryDiagnostic[] = [];
  const broadAlbumQuery = buildBroadAlbumQuery(request);
  const subtypeSpecificQuery = buildSubtypeSpecificQuery(request);
  const evaluationOrder = buildSoldEvaluationOrder(
    queryPlan,
    broadAlbumQuery,
    subtypeSpecificQuery
  );

  if (!soldApiUrl || !soldApiKey || !query) {
    return {
      ...createEmptySoldSignals(query, queryCandidates, 'unavailable'),
      queryDiagnostics,
      broadAlbumQuery,
      subtypeSpecificQuery,
      queryResolution,
    };
  }

  try {
    const endpoint = soldApiUrl.endsWith('/findCompletedItems')
      ? soldApiUrl
      : `${soldApiUrl.replace(/\/$/, '')}/findCompletedItems`;
    const host = new URL(endpoint).host;

    let selectedResult = {
      ...createEmptySoldSignals(query, queryCandidates, 'unavailable'),
      queryDiagnostics,
      broadAlbumQuery,
      subtypeSpecificQuery,
      queryResolution,
    };
    let lastErrorMessage: string | undefined;
    const evaluatedCandidates: SoldCandidateEvaluation[] = [];

    for (const index of evaluationOrder) {
      const plannedCandidate = queryPlan[index];
      if (!plannedCandidate) {
        continue;
      }

      const candidate = plannedCandidate.query;

      try {
        const response = await axios.post<SoldProviderResponse>(
          endpoint,
          {
            keywords: candidate,
            excluded_keywords: 'set lot bundle photocard fanmade replica unofficial',
            max_search_results: 120,
            remove_outliers: true,
            site_id: '0',
          },
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
              'x-rapidapi-key': soldApiKey,
              'x-rapidapi-host': host,
            },
          }
        );

        const data = response.data;
        const normalizedProducts = normalizeProducts(data.products);
        const { soldVelocity, recentSoldCount7d, soldBucketDebug } = bucketSoldVelocity(
          normalizedProducts.allItems,
          normalizedProducts,
          request.timestamp
        );
        const soldResultsCount =
          typeof data.results === 'number' && Number.isFinite(data.results) ? data.results : null;
        const titleMatchScore = computeTitleMatchScore(normalizedProducts.allItems, request);
        const subtypeAligned = computeSubtypeAlignment(normalizedProducts.allItems, request);

        queryDiagnostics.push({
          query: candidate,
          tier: index + 1,
          family: plannedCandidate.family,
          soldResultsCount,
          recentSoldCount7d,
          titleMatchScore: round(titleMatchScore),
          subtypeAligned,
          status: data.success === false ? 'error' : 'ok',
        });

        const candidateScore =
          ((soldResultsCount ?? normalizedProducts.allItems.length) *
            (0.5 + titleMatchScore) *
            100 +
            recentSoldCount7d * 25 +
            (subtypeAligned ? 6 : 0) +
            getFamilyPreferenceBonus(queryPlan[index]?.family)) |
          0;

        evaluatedCandidates.push({
          query: candidate,
          tier: index + 1,
          family: plannedCandidate.family,
          soldResultsCount,
          recentSoldCount7d,
          titleMatchScore,
          subtypeAligned,
          confidence: scoreSoldConfidence(soldResultsCount, normalizedProducts.soldItemsSample),
          soldAveragePriceUsd: normalizePrice(data.average_price),
          soldMedianPriceUsd: normalizePrice(data.median_price),
          soldMinPriceUsd: normalizePrice(data.min_price),
          soldMaxPriceUsd: normalizePrice(data.max_price),
          soldItemsSample: normalizedProducts.soldItemsSample,
          soldVelocity,
          soldBucketDebug,
          responseUrl: typeof data.response_url === 'string' ? data.response_url : null,
          status: data.success === false ? 'error' : 'ok',
          querySelectionScore: candidateScore,
        });
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        queryDiagnostics.push({
          query: candidate,
          tier: index + 1,
          family: plannedCandidate.family,
          soldResultsCount: null,
          recentSoldCount7d: null,
          titleMatchScore: null,
          status: 'error',
          note: lastErrorMessage,
        });
      }
    }

    const broadAlbumCandidate =
      evaluatedCandidates.find(
        (candidate) =>
          candidate.family === 'artist_album_core' ||
          (broadAlbumQuery !== null &&
            candidate.query.toLowerCase() === broadAlbumQuery.toLowerCase())
      ) ?? null;
    const subtypeCandidate =
      evaluatedCandidates.find(
        (candidate) =>
          isSubtypeSpecificFamily(candidate.family) ||
          (subtypeSpecificQuery !== null &&
            candidate.query.toLowerCase() === subtypeSpecificQuery.toLowerCase())
      ) ?? null;

    for (const diagnostic of queryDiagnostics) {
      if (!isSubtypeSpecificFamily(diagnostic.family) || !broadAlbumCandidate) {
        continue;
      }

      const candidateCount = diagnostic.soldResultsCount ?? 0;
      const broadCount = broadAlbumCandidate.soldResultsCount ?? 0;
      diagnostic.tooNarrow =
        broadCount >= 5 &&
        broadCount >= Math.max(candidateCount * 2, candidateCount + 4) &&
        broadAlbumCandidate.titleMatchScore >= 0.45;
    }

    const selectedCandidate = evaluatedCandidates
      .filter((candidate) => candidate.status === 'ok')
      .sort((left, right) => {
        const leftDiagnostic = queryDiagnostics.find(
          (diagnostic) => diagnostic.query.toLowerCase() === left.query.toLowerCase()
        );
        const rightDiagnostic = queryDiagnostics.find(
          (diagnostic) => diagnostic.query.toLowerCase() === right.query.toLowerCase()
        );
        const leftPenalty = leftDiagnostic?.tooNarrow ? 120 : 0;
        const rightPenalty = rightDiagnostic?.tooNarrow ? 120 : 0;
        const leftScore = left.querySelectionScore - leftPenalty;
        const rightScore = right.querySelectionScore - rightPenalty;

        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        if (right.titleMatchScore !== left.titleMatchScore) {
          return right.titleMatchScore - left.titleMatchScore;
        }

        return left.tier - right.tier;
      })[0];

    if (selectedCandidate) {
      const subtypeDiagnostic = subtypeCandidate
        ? queryDiagnostics.find(
            (diagnostic) => diagnostic.query.toLowerCase() === subtypeCandidate.query.toLowerCase()
          )
        : undefined;

      selectedResult = {
        provider: 'third_party_sold_api',
        confidence: selectedCandidate.confidence,
        soldResultsCount: selectedCandidate.soldResultsCount,
        soldAveragePriceUsd: selectedCandidate.soldAveragePriceUsd,
        soldMedianPriceUsd: selectedCandidate.soldMedianPriceUsd,
        soldMinPriceUsd: selectedCandidate.soldMinPriceUsd,
        soldMaxPriceUsd: selectedCandidate.soldMaxPriceUsd,
        soldItemsSample: selectedCandidate.soldItemsSample,
        soldVelocity: selectedCandidate.soldVelocity,
        recentSoldCount7d: selectedCandidate.recentSoldCount7d,
        soldBucketDebug: selectedCandidate.soldBucketDebug,
        query: selectedCandidate.query,
        queryCandidates,
        queryDiagnostics: [...queryDiagnostics],
        selectedQuery: selectedCandidate.query,
        selectedQueryTier: selectedCandidate.tier,
        selectedQueryFamily: selectedCandidate.family ?? null,
        broadAlbumQuery,
        subtypeSpecificQuery,
        querySelectionReason: buildSelectionReason(
          selectedCandidate,
          broadAlbumCandidate,
          subtypeCandidate,
          subtypeDiagnostic
        ),
        responseUrl: selectedCandidate.responseUrl,
        status: selectedCandidate.status,
        queryResolution,
      };
    }

    if (selectedResult.status === 'unavailable' && queryDiagnostics.length > 0) {
      return {
        ...createEmptySoldSignals(query, queryCandidates, 'error', lastErrorMessage),
        queryDiagnostics,
        broadAlbumQuery,
        subtypeSpecificQuery,
        queryResolution,
      };
    }

    return {
      ...selectedResult,
      queryResolution,
    };
  } catch (error) {
    return {
      ...createEmptySoldSignals(
        query,
        queryCandidates,
        'error',
        error instanceof Error ? error.message : String(error)
      ),
      queryDiagnostics,
      broadAlbumQuery,
      subtypeSpecificQuery,
      queryResolution,
    };
  }
}
