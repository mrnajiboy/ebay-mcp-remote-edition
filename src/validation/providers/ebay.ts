import axios from 'axios';
import { getBaseUrl } from '@/config/environment.js';
import type { EbaySellerApi } from '@/api/index.js';
import type { EbayValidationSignals, ValidationRunRequest } from '../types.js';
import { getValidationEffectiveContext } from '../effective-context.js';
import {
  buildResolvedBrowseQueryPlan,
  extractSemanticTokens,
  titleAlreadyContainsArtist,
} from './query-utils.js';

interface BrowseItemSummary {
  title?: string;
  price?: { value?: string };
  shippingOptions?: { shippingCost?: { value?: string } }[];
}

interface BrowseSearchResponse {
  total?: number;
  itemSummaries?: BrowseItemSummary[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildEbayValidationQueries(request: ValidationRunRequest): string[] {
  return buildResolvedBrowseQueryPlan(request).queryPlan.map((candidate) => candidate.query);
}

function deriveTrend(current: number | null, previous: number | null, fallback: string): string {
  if (current === null || previous === null || previous <= 0) {
    return fallback || 'Stable';
  }

  const deltaRatio = (current - previous) / previous;
  if (deltaRatio >= 0.08) return 'Rising';
  if (deltaRatio <= -0.08) return 'Falling';
  return 'Stable';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

const MAX_UNVERIFIED_BROWSE_TOTAL = 1000;

function tokenPattern(token: string): RegExp {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`,
    'iu'
  );
}

function getBrowseEvidenceContext(request: ValidationRunRequest): {
  primaryArtist: string | null;
  requiredTokens: string[];
} {
  const effectiveContext = getValidationEffectiveContext(request);
  const primaryArtist =
    effectiveContext.searchArtist ?? request.item.canonicalArtists[0]?.trim() ?? null;
  const contextPhrase =
    effectiveContext.sourceType === 'event'
      ? [effectiveContext.searchEvent, effectiveContext.searchItem, effectiveContext.searchLocation]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join(' ')
      : (effectiveContext.searchAlbum ?? effectiveContext.searchItem ?? request.item.name);

  return {
    primaryArtist,
    requiredTokens: extractSemanticTokens(contextPhrase),
  };
}

function titleMatchesBrowseEvidence(
  title: string | undefined,
  evidenceContext: ReturnType<typeof getBrowseEvidenceContext>
): boolean {
  if (!title) {
    return false;
  }

  if (
    evidenceContext.primaryArtist &&
    !titleAlreadyContainsArtist(title, evidenceContext.primaryArtist)
  ) {
    return false;
  }

  if (evidenceContext.requiredTokens.length === 0) {
    return true;
  }

  return evidenceContext.requiredTokens.some((token) => tokenPattern(token).test(title));
}

function applyBrowseCountGuard(
  request: ValidationRunRequest,
  itemSummaries: BrowseItemSummary[],
  rawTotalListings: number
): {
  metricSummaries: BrowseItemSummary[];
  safeListingsCount: number | null;
  guardNote: string | null;
  titleMatchedCount: number | null;
} {
  if (rawTotalListings <= MAX_UNVERIFIED_BROWSE_TOTAL) {
    return {
      metricSummaries: itemSummaries,
      safeListingsCount: rawTotalListings,
      guardNote: null,
      titleMatchedCount: null,
    };
  }

  const evidenceContext = getBrowseEvidenceContext(request);
  const matchingSummaries = itemSummaries.filter((item) =>
    titleMatchesBrowseEvidence(item.title, evidenceContext)
  );
  const safeListingsCount = matchingSummaries.length > 0 ? matchingSummaries.length : null;

  return {
    metricSummaries: matchingSummaries,
    safeListingsCount,
    guardNote:
      safeListingsCount === null
        ? `Suppressed eBay Browse total ${rawTotalListings} because it exceeds ${MAX_UNVERIFIED_BROWSE_TOTAL} and the sampled titles did not prove artist/item relevance.`
        : `Replaced eBay Browse total ${rawTotalListings} with ${safeListingsCount} artist/item-matched sampled row(s) because the aggregate exceeds ${MAX_UNVERIFIED_BROWSE_TOTAL}.`,
    titleMatchedCount: matchingSummaries.length,
  };
}

function getAxiosFailureDebug(error: unknown): {
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
} {
  if (!axios.isAxiosError(error)) {
    return {
      responseStatus: null,
      responseBodyExcerpt: null,
    };
  }

  const responseStatus = error.response?.status ?? null;
  const rawBody: unknown = error.response?.data;

  if (rawBody === undefined) {
    return {
      responseStatus,
      responseBodyExcerpt: null,
    };
  }

  const bodyText = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2);

  return {
    responseStatus,
    responseBodyExcerpt: bodyText.slice(0, 500),
  };
}

export async function getEbayValidationSignals(
  api: EbaySellerApi,
  request: ValidationRunRequest
): Promise<EbayValidationSignals> {
  const { queryPlan, queryResolution } = buildResolvedBrowseQueryPlan(request);
  const queryCandidates = queryPlan.map((candidate) => candidate.query);
  const ebayQuery = queryCandidates[0] ?? '';
  const fallbackTrend = request.validation.currentMetrics.marketPriceTrend || 'Stable';

  const emptyResult: EbayValidationSignals = {
    avgWatchersPerListing: null,
    preOrderListingsCount: null,
    marketPriceUsd: null,
    avgShippingCostUsd: null,
    competitionLevel: null,
    marketPriceTrend: fallbackTrend,
    ebayQuery,
    queryCandidates,
    selectedQuery: ebayQuery || undefined,
    selectedQueryTier: ebayQuery ? 1 : null,
    queryDiagnostics: [],
    selectionReason: queryCandidates.length
      ? 'Cleaned browse candidates were generated, but none have been evaluated yet.'
      : 'No valid browse query candidates were generated after sanitization and semantic filtering.',
    sampleSize: 0,
    soldVelocity: {
      day1Sold: null,
      day2Sold: null,
      day3Sold: null,
      day4Sold: null,
      day5Sold: null,
      daysTracked: null,
    },
    queryResolution,
  };

  if (queryCandidates.length === 0) {
    return emptyResult;
  }

  try {
    const environment = api.getAuthClient().getConfig().environment;
    const browseUrl = new URL(
      '/buy/browse/v1/item_summary/search',
      getBaseUrl(environment)
    ).toString();
    let selectedResult = emptyResult;
    let bestScore = -1;
    const queryDiagnostics: NonNullable<EbayValidationSignals['queryDiagnostics']> = [];

    for (const [index, query] of queryCandidates.entries()) {
      const response = await api.getAuthClient().getWithFullUrl<BrowseSearchResponse>(browseUrl, {
        q: query,
        limit: 25,
        sort: 'newlyListed',
      });

      const itemSummaries = response.itemSummaries ?? [];
      const rawTotalListings =
        typeof response.total === 'number' && Number.isFinite(response.total)
          ? response.total
          : itemSummaries.length;
      const { metricSummaries, safeListingsCount, guardNote, titleMatchedCount } =
        applyBrowseCountGuard(request, itemSummaries, rawTotalListings);
      const prices = metricSummaries
        .map((item) => Number(item.price?.value ?? Number.NaN))
        .filter((value) => Number.isFinite(value) && value > 0);
      const shipping = metricSummaries
        .map((item) => Number(item.shippingOptions?.[0]?.shippingCost?.value ?? Number.NaN))
        .filter((value) => Number.isFinite(value) && value >= 0);

      const marketPriceUsd = median(prices);
      const avgShippingCostUsd =
        shipping.length > 0
          ? shipping.reduce((sum, value) => sum + value, 0) / shipping.length
          : null;
      const totalListings = safeListingsCount;
      const attemptScore = Math.max(metricSummaries.length, totalListings ?? 0);

      queryDiagnostics.push({
        query,
        tier: index + 1,
        family: queryPlan[index]?.family,
        itemSummaryCount: metricSummaries.length,
        rawItemSummaryCount: itemSummaries.length,
        totalListings,
        rawTotalListings,
        countGuard: guardNote
          ? {
              applied: true,
              note: guardNote,
              titleMatchedCount,
            }
          : { applied: false },
      });

      const hasSufficientDepth = metricSummaries.length >= 5 || (totalListings ?? 0) >= 5;

      if (attemptScore <= bestScore) {
        if (hasSufficientDepth) {
          break;
        }
        continue;
      }

      bestScore = attemptScore;

      selectedResult = {
        avgWatchersPerListing: null,
        preOrderListingsCount: totalListings,
        marketPriceUsd: marketPriceUsd === null ? null : round(marketPriceUsd),
        avgShippingCostUsd: avgShippingCostUsd === null ? null : round(avgShippingCostUsd),
        competitionLevel: totalListings,
        marketPriceTrend: deriveTrend(
          marketPriceUsd,
          request.validation.currentMetrics.marketPriceUsd,
          fallbackTrend
        ),
        ebayQuery: query,
        queryCandidates,
        selectedQuery: query,
        selectedQueryTier: index + 1,
        queryDiagnostics: [...queryDiagnostics],
        selectionReason: guardNote
          ? guardNote
          : hasSufficientDepth
            ? 'Selected because this cleaned browse candidate produced sufficient listing depth.'
            : attemptScore > 0
              ? 'Selected as the strongest cleaned browse fallback after higher-priority candidates returned weaker results.'
              : 'All cleaned browse candidates seen so far returned zero results; keeping the highest-priority candidate for traceability.',
        sampleSize: metricSummaries.length,
        soldVelocity: emptyResult.soldVelocity,
        queryResolution,
      };

      if (hasSufficientDepth) {
        break;
      }
    }

    return {
      ...selectedResult,
      queryDiagnostics,
      selectionReason:
        selectedResult.selectionReason ??
        'Browse selection completed without a stronger candidate than the highest-priority cleaned query.',
    };
  } catch (error) {
    const failureDebug = getAxiosFailureDebug(error);
    return {
      ...emptyResult,
      selectionReason:
        'Browse query execution failed before result selection could complete; returning the cleaned fallback candidate set for debug traceability.',
      errorMessage: error instanceof Error ? error.message : String(error),
      responseStatus: failureDebug.responseStatus,
      responseBodyExcerpt: failureDebug.responseBodyExcerpt,
      queryResolution,
    };
  }
}
