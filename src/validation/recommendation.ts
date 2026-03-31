import type {
  ChartValidationSignals,
  EbayValidationSignals,
  SocialValidationSignals,
  TrackingCadence,
  ValidationRunRequest,
} from './types.js';

interface ValidationRecommendationInput {
  ebay: EbayValidationSignals;
  social: SocialValidationSignals;
  chart: ChartValidationSignals;
}

function addHours(timestamp: string, hours: number): string {
  return new Date(new Date(timestamp).getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function buildValidationRecommendation(
  request: ValidationRunRequest,
  signals: ValidationRecommendationInput
): {
  buyDecision: string;
  automationStatus: string;
  trackingCadence: TrackingCadence;
  shouldAutoTrack: boolean;
  nextCheckAt: string | null;
  latestAiRecommendation: string;
  latestAiConfidence: 'High' | 'Medium' | 'Low';
  monitoringNotes: string;
} {
  const dDay = request.validation.dDay;
  const baseCadence: TrackingCadence =
    typeof dDay === 'number' && dDay >= -3 && dDay <= 3 ? 'Hourly' : 'Daily';

  const shouldAutoTrack =
    request.validation.autoCheckEnabled &&
    request.validation.automationStatus === 'Watching' &&
    request.validation.buyDecision === 'Watching';

  const trackingCadence: TrackingCadence = shouldAutoTrack ? baseCadence : 'Off';
  const nextCheckAt = !shouldAutoTrack
    ? null
    : trackingCadence === 'Hourly'
      ? addHours(request.timestamp, 1)
      : addHours(request.timestamp, 24);

  const marketPrice = signals.ebay.marketPriceUsd;
  const wholesale = request.item.wholesalePrice;
  const marginRatio =
    marketPrice !== null && wholesale !== null && wholesale > 0
      ? (marketPrice - wholesale) / wholesale
      : null;

  let latestAiRecommendation = 'Continue watching until stronger market signal appears.';
  let latestAiConfidence: 'High' | 'Medium' | 'Low' = 'Medium';
  let monitoringNotes = 'Baseline recommendation generated from current validation state.';

  if (!shouldAutoTrack) {
    latestAiRecommendation =
      'Automatic tracking paused because the validation is no longer in a watchable state.';
    latestAiConfidence = 'High';
    monitoringNotes =
      'Stop conditions were met, so automation will not schedule another validation run.';
  } else if (
    marginRatio !== null &&
    marginRatio >= 1 &&
    signals.ebay.preOrderListingsCount !== null &&
    signals.ebay.preOrderListingsCount >= 25
  ) {
    latestAiRecommendation =
      'Demand and pricing look constructive. Continue tracking closely and be ready to upgrade from watch status if sell-through strengthens.';
    latestAiConfidence = 'High';
    monitoringNotes =
      'Healthy active-listing volume and strong projected margin support continued monitoring.';
  } else if (
    signals.social.youtubeViews24hMillions !== null ||
    signals.social.redditPostsCount7d !== null
  ) {
    latestAiRecommendation =
      'Demand signals are mixed. Keep monitoring until eBay pricing and social momentum become more decisive.';
    latestAiConfidence = 'Medium';
    monitoringNotes =
      'Cross-channel activity exists, but the combined signal is not strong enough for an automatic buy change.';
  }

  return {
    buyDecision: request.validation.buyDecision,
    automationStatus: shouldAutoTrack ? 'Watching' : 'Paused',
    trackingCadence,
    shouldAutoTrack,
    nextCheckAt,
    latestAiRecommendation,
    latestAiConfidence,
    monitoringNotes,
  };
}
