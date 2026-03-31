import { getBaseUrl } from '@/config/environment.js';
import type { EbaySellerApi } from '@/api/index.js';
import type { EbayValidationSignals, ValidationRunRequest } from '../types.js';

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

function buildQueryTerms(request: ValidationRunRequest): string[] {
  const terms = new Set<string>();

  const addTerms = (values: (string | null | undefined)[], maxTerms = values.length): void => {
    for (const value of values) {
      if (!value) continue;
      const normalized = value.trim();
      if (!normalized) continue;
      terms.add(normalized);
      if (terms.size >= maxTerms) {
        break;
      }
    }
  };

  addTerms([request.item.name], 1);
  addTerms(request.item.canonicalArtists, 3);
  addTerms(request.item.relatedAlbums, 5);
  addTerms(request.item.variation, 7);
  addTerms([request.validation.validationType], 8);

  return Array.from(terms);
}

export function buildEbayValidationQuery(request: ValidationRunRequest): string {
  return buildQueryTerms(request).join(' ').replace(/\s+/g, ' ').trim();
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

export async function getEbayValidationSignals(
  api: EbaySellerApi,
  request: ValidationRunRequest
): Promise<EbayValidationSignals> {
  const ebayQuery = buildEbayValidationQuery(request);
  const fallbackTrend = request.validation.currentMetrics.marketPriceTrend || 'Stable';

  const emptyResult: EbayValidationSignals = {
    avgWatchersPerListing: null,
    preOrderListingsCount: null,
    marketPriceUsd: null,
    avgShippingCostUsd: null,
    competitionLevel: null,
    marketPriceTrend: fallbackTrend,
    ebayQuery,
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

  if (!ebayQuery) {
    return emptyResult;
  }

  try {
    const environment = api.getAuthClient().getConfig().environment;
    const browseUrl = `${getBaseUrl(environment)}/buy/browse/v1/item_summary/search`;
    const response = await api.getAuthClient().getWithFullUrl<BrowseSearchResponse>(browseUrl, {
      q: ebayQuery,
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

    return {
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
      ebayQuery,
      sampleSize: itemSummaries.length,
      soldVelocity: emptyResult.soldVelocity,
    };
  } catch {
    return emptyResult;
  }
}
