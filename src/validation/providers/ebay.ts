import axios from 'axios';
import { getBaseUrl } from '@/config/environment.js';
import type { EbaySellerApi } from '@/api/index.js';
import type { EbayValidationSignals, ValidationRunRequest } from '../types.js';
import { buildValidationQueryCandidates } from './query-utils.js';

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
  return buildValidationQueryCandidates(request);
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
  const queryCandidates = buildEbayValidationQueries(request);
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
      day1Sold: request.validation.currentMetrics.day1Sold,
      day2Sold: request.validation.currentMetrics.day2Sold,
      day3Sold: request.validation.currentMetrics.day3Sold,
      day4Sold: request.validation.currentMetrics.day4Sold,
      day5Sold: request.validation.currentMetrics.day5Sold,
      daysTracked: request.validation.currentMetrics.daysTracked,
    },
  };

  if (queryCandidates.length === 0) {
    return emptyResult;
  }

  try {
    const environment = api.getAuthClient().getConfig().environment;
    const browseUrl = `${getBaseUrl(environment)}/buy/browse/v1/item_summary/search`;
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
      const prices = itemSummaries
        .map((item) => Number(item.price?.value ?? Number.NaN))
        .filter((value) => Number.isFinite(value) && value > 0);
      const shipping = itemSummaries
        .map((item) => Number(item.shippingOptions?.[0]?.shippingCost?.value ?? Number.NaN))
        .filter((value) => Number.isFinite(value) && value >= 0);

      const marketPriceUsd = median(prices);
      const avgShippingCostUsd =
        shipping.length > 0
          ? shipping.reduce((sum, value) => sum + value, 0) / shipping.length
          : null;
      const totalListings =
        typeof response.total === 'number' && Number.isFinite(response.total)
          ? response.total
          : itemSummaries.length;
      const attemptScore = Math.max(itemSummaries.length, totalListings);

      queryDiagnostics.push({
        query,
        tier: index + 1,
        itemSummaryCount: itemSummaries.length,
        totalListings,
      });

      if (attemptScore <= bestScore) {
        if (itemSummaries.length >= 5 || totalListings >= 5) {
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
        selectionReason:
          itemSummaries.length >= 5 || totalListings >= 5
            ? 'Selected because this cleaned browse candidate produced sufficient listing depth.'
            : attemptScore > 0
              ? 'Selected as the strongest cleaned browse fallback after higher-priority candidates returned weaker results.'
              : 'All cleaned browse candidates seen so far returned zero results; keeping the highest-priority candidate for traceability.',
        sampleSize: itemSummaries.length,
        soldVelocity: emptyResult.soldVelocity,
      };

      if (itemSummaries.length >= 5 || totalListings >= 5) {
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
    };
  }
}
