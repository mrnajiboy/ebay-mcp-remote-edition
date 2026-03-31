import type { EbaySellerApi } from '@/api/index.js';
import type { TerapeakValidationSignals, ValidationRunRequest } from '../types.js';
import { buildValidationQueryCandidates } from './query-utils.js';

export async function getTerapeakValidationSignals(
  _api: EbaySellerApi,
  request: ValidationRunRequest
): Promise<TerapeakValidationSignals> {
  await Promise.resolve();

  const queryCandidates = buildValidationQueryCandidates(request);
  const currentQuery = queryCandidates[0] ?? null;
  const previousPobQuery = queryCandidates[1] ?? currentQuery;

  return {
    avgWatchersPerListing: null,
    preOrderListingsCount: null,
    marketPriceUsd: null,
    avgShippingCostUsd: null,
    competitionLevel: null,
    previousPobAvgPriceUsd: null,
    previousPobSellThroughPct: null,
    currentListingsCount: null,
    soldListingsCount: null,
    provider: 'none',
    confidence: 'Low',
    queryDebug: {
      currentQuery,
      previousPobQuery,
      selectedMode: 'combined',
      currentResultCount: null,
      previousPobResultCount: null,
      notes:
        'Terapeak/eBay research provider contract is in place, but live authenticated research retrieval is not implemented yet.',
    },
  };
}
