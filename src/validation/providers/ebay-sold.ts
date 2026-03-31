import axios from 'axios';
import type {
  EbaySoldValidationSignals,
  SoldItemSample,
  ValidationRunRequest,
  ValidationSignalConfidence,
  ValidationSoldVelocity,
} from '../types.js';
import { buildValidationQueryCandidates } from './query-utils.js';

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

function buildSoldKeywords(request: ValidationRunRequest): string[] {
  return buildValidationQueryCandidates(request);
}

function parseSoldDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

function normalizeProducts(products: SoldProviderProduct[] | undefined): SoldItemSample[] {
  return (products ?? []).slice(0, 10).map((product) => ({
    title: product.title?.trim() ?? 'Untitled sold listing',
    soldAt: parseSoldDate(product.date_sold),
    priceUsd: normalizePrice(product.sale_price),
    itemUrl: typeof product.link === 'string' ? product.link : null,
  }));
}

function bucketSoldVelocity(
  soldItemsSample: SoldItemSample[],
  requestTimestamp: string
): ValidationSoldVelocity {
  const requestDate = new Date(requestTimestamp);
  if (!Number.isFinite(requestDate.getTime())) {
    return {
      day1Sold: null,
      day2Sold: null,
      day3Sold: null,
      day4Sold: null,
      day5Sold: null,
      daysTracked: null,
    };
  }

  const buckets = [0, 0, 0, 0, 0];
  let maxTrackedDay = 0;

  for (const item of soldItemsSample) {
    if (!item.soldAt) {
      continue;
    }

    const soldDate = new Date(item.soldAt);
    if (!Number.isFinite(soldDate.getTime()) || soldDate.getTime() > requestDate.getTime()) {
      continue;
    }

    const diffDays = Math.floor(
      (requestDate.getTime() - soldDate.getTime()) / (24 * 60 * 60 * 1000)
    );
    if (diffDays >= 0 && diffDays < 5) {
      buckets[diffDays] += 1;
      maxTrackedDay = Math.max(maxTrackedDay, diffDays + 1);
    }
  }

  return {
    day1Sold: buckets[0],
    day2Sold: buckets[1],
    day3Sold: buckets[2],
    day4Sold: buckets[3],
    day5Sold: buckets[4],
    daysTracked: maxTrackedDay > 0 ? maxTrackedDay : null,
  };
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
    query,
    queryCandidates,
    selectedQuery: query ?? undefined,
    selectedQueryTier: query ? 1 : null,
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
  const queryCandidates = buildSoldKeywords(request);
  const query = queryCandidates[0] ?? null;

  if (!soldApiUrl || !soldApiKey || !query) {
    return createEmptySoldSignals(query, queryCandidates, 'unavailable');
  }

  try {
    const endpoint = soldApiUrl.endsWith('/findCompletedItems')
      ? soldApiUrl
      : `${soldApiUrl.replace(/\/$/, '')}/findCompletedItems`;
    const host = new URL(endpoint).host;

    let selectedResult = createEmptySoldSignals(query, queryCandidates, 'unavailable');

    for (const [index, candidate] of queryCandidates.entries()) {
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
      const soldItemsSample = normalizeProducts(data.products);
      const soldVelocity = bucketSoldVelocity(soldItemsSample, request.timestamp);
      const soldResultsCount =
        typeof data.results === 'number' && Number.isFinite(data.results) ? data.results : null;

      selectedResult = {
        provider: 'third_party_sold_api',
        confidence: scoreSoldConfidence(soldResultsCount, soldItemsSample),
        soldResultsCount,
        soldAveragePriceUsd: normalizePrice(data.average_price),
        soldMedianPriceUsd: normalizePrice(data.median_price),
        soldMinPriceUsd: normalizePrice(data.min_price),
        soldMaxPriceUsd: normalizePrice(data.max_price),
        soldItemsSample,
        soldVelocity,
        query: candidate,
        queryCandidates,
        selectedQuery: candidate,
        selectedQueryTier: index + 1,
        responseUrl: typeof data.response_url === 'string' ? data.response_url : null,
        status: data.success === false ? 'error' : 'ok',
      };

      if ((soldResultsCount ?? 0) >= 5) {
        break;
      }
    }

    return selectedResult;
  } catch (error) {
    return createEmptySoldSignals(
      query,
      queryCandidates,
      'error',
      error instanceof Error ? error.message : String(error)
    );
  }
}
