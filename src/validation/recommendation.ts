import type {
  ChartValidationSignals,
  EbaySoldValidationSignals,
  EbayValidationSignals,
  PreviousComebackResearchSignals,
  SocialValidationSignals,
  TerapeakValidationSignals,
  TrackingCadence,
  ValidationRunRequest,
} from './types.js';

interface ValidationRecommendationInput {
  ebay: EbayValidationSignals;
  sold: EbaySoldValidationSignals;
  terapeak: TerapeakValidationSignals;
  social: SocialValidationSignals;
  chart: ChartValidationSignals;
  research: PreviousComebackResearchSignals;
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

  const marketPrice =
    signals.terapeak.marketPriceUsd ??
    signals.sold.soldMedianPriceUsd ??
    signals.ebay.marketPriceUsd;
  const preorderListingsCount =
    signals.terapeak.preOrderListingsCount ?? signals.ebay.preOrderListingsCount;
  const wholesale = request.item.wholesalePrice;
  const marginRatio =
    marketPrice !== null && wholesale !== null && wholesale > 0
      ? (marketPrice - wholesale) / wholesale
      : null;
  const recentSoldCount = [
    signals.sold.soldVelocity.day1Sold,
    signals.sold.soldVelocity.day2Sold,
    signals.sold.soldVelocity.day3Sold,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0);

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
    preorderListingsCount !== null &&
    preorderListingsCount >= 25
  ) {
    latestAiRecommendation =
      'Demand and pricing look constructive. Continue tracking closely and be ready to upgrade from watch status if sell-through strengthens.';
    latestAiConfidence = 'High';
    monitoringNotes =
      'Healthy active-listing volume and strong projected margin support continued monitoring.';
    if (signals.sold.soldMedianPriceUsd !== null) {
      monitoringNotes =
        'Healthy active-listing volume and sold comparables support continued monitoring without yet forcing a buy-state change.';
    }
  } else if (
    signals.sold.soldMedianPriceUsd !== null &&
    recentSoldCount > 0 &&
    signals.sold.confidence !== 'Low'
  ) {
    latestAiRecommendation =
      'Recent sold comparables support real resale demand. Continue watching closely while waiting for a stronger conviction signal.';
    latestAiConfidence = signals.sold.confidence === 'High' ? 'High' : 'Medium';
    monitoringNotes =
      'Sold-item data confirms recent transaction activity, improving confidence while remaining conservative on buy-state changes.';
  } else if (signals.sold.soldMedianPriceUsd !== null) {
    latestAiRecommendation =
      'Sold comps are available, but sample depth is still limited. Keep monitoring until resale momentum becomes clearer.';
    latestAiConfidence = 'Medium';
    monitoringNotes =
      'Temporary sold-provider data is present, but sample depth is not yet strong enough to justify an automatic buy-decision change.';
  } else if (
    signals.social.twitterTrending === true ||
    (signals.social.youtubeViews24hMillions !== null &&
      signals.social.youtubeViews24hMillions >= 0.1) ||
    (signals.social.redditPostsCount7d !== null && signals.social.redditPostsCount7d >= 5)
  ) {
    latestAiRecommendation =
      'Demand signals are mixed. Keep monitoring until eBay pricing and social momentum become more decisive.';
    latestAiConfidence = 'Medium';
    monitoringNotes =
      'Cross-channel social activity exists, but it is only being used as a supporting confidence signal and is not strong enough to justify an automatic buy change.';
  }

  if (
    signals.terapeak.previousPobSellThroughPct !== null &&
    signals.terapeak.previousPobSellThroughPct >= 50
  ) {
    monitoringNotes +=
      ' Previous POB sell-through research suggests the comparable release sold through efficiently.';
    if (latestAiConfidence !== 'High') {
      latestAiConfidence = 'Medium';
    }
  }

  if (signals.research.previousComebackFirstWeekSales !== null) {
    monitoringNotes += ` Previous comeback first-week sales reference: ${signals.research.previousComebackFirstWeekSales}.`;
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
