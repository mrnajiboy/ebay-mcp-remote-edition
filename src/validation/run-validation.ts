import type { EbaySellerApi } from '@/api/index.js';
import { validationRunRequestSchema } from './schemas.js';
import type { ValidationRunRequest, ValidationRunResponse } from './types.js';
import { getEbayValidationSignals } from './providers/ebay.js';
import { getSocialValidationSignals } from './providers/social.js';
import { getChartValidationSignals } from './providers/chart.js';
import { buildValidationRecommendation } from './recommendation.js';

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
  social: ReturnType<typeof getSocialValidationSignals>,
  chart: ReturnType<typeof getChartValidationSignals>
): Record<string, unknown> {
  return {
    ebay: {
      status: ebay.sampleSize > 0 ? 'ok' : 'partial',
      confidence: ebay.sampleSize >= 10 ? 'medium' : 'low',
      sampleSize: ebay.sampleSize,
      hasMarketPrice: ebay.marketPriceUsd !== null,
      hasShipping: ebay.avgShippingCostUsd !== null,
      hasWatchers: ebay.avgWatchersPerListing !== null,
    },
    social: {
      status: 'stub',
      confidence: 'low',
      hasSignals:
        social.twitterTrending ||
        social.youtubeViews24hMillions !== null ||
        social.redditPostsCount7d !== null,
    },
    chart: {
      status: 'stub',
      confidence: 'low',
      hasSignals: Object.keys(chart).length > 0,
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
    const social = getSocialValidationSignals(request);
    const chart = getChartValidationSignals(request);

    const recommendation = buildValidationRecommendation(request, { ebay, social, chart });
    const mergedSignals = { ebay, social, chart };

    return {
      status: 'ok',
      validationId: request.validationId,
      writes: {
        avgWatchersPerListing: ebay.avgWatchersPerListing,
        preOrderListingsCount: ebay.preOrderListingsCount,
        twitterTrending: social.twitterTrending,
        youtubeViews24hMillions: social.youtubeViews24hMillions,
        redditPostsCount7d: social.redditPostsCount7d,
        marketPriceUsd: ebay.marketPriceUsd,
        avgShippingCostUsd: ebay.avgShippingCostUsd,
        competitionLevel: ebay.competitionLevel,
        marketPriceTrend: ebay.marketPriceTrend,
        day1Sold: ebay.soldVelocity.day1Sold,
        day2Sold: ebay.soldVelocity.day2Sold,
        day3Sold: ebay.soldVelocity.day3Sold,
        day4Sold: ebay.soldVelocity.day4Sold,
        day5Sold: ebay.soldVelocity.day5Sold,
        daysTracked: ebay.soldVelocity.daysTracked,
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
        sampleSize: ebay.sampleSize,
        sourceSet: ['ebay', 'social', 'chart'],
        providers: buildProviderDebug(ebay, social, chart),
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
