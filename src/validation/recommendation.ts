import type {
  ChartValidationSignals,
  EbaySoldValidationSignals,
  EbayValidationSignals,
  PreviousComebackResearchSignals,
  SocialValidationSignals,
  TerapeakValidationSignals,
  TrackingCadence,
  ValidationEffectiveContext,
  ValidationRunRequest,
} from './types.js';
import {
  computeWeightedValidationScore,
  shouldApplyAgeAwareCalibration,
  type WeightedScoreResult,
} from './threshold-calibration.js';

interface ValidationRecommendationInput {
  ebay: EbayValidationSignals;
  sold: EbaySoldValidationSignals;
  terapeak: TerapeakValidationSignals;
  social: SocialValidationSignals;
  chart: ChartValidationSignals;
  research: PreviousComebackResearchSignals;
  effectiveContext: ValidationEffectiveContext;
  // Optional: artist momentum score from Artist/Group table
  // (not available in the base request; injected by the Airtable automation
  //  via the effective-context or as a separate field)
  momentumScore?: number | null;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function nextTopOfHour(timestamp: string): string {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  date.setTime(date.getTime() + ONE_HOUR_MS);
  return date.toISOString();
}

function nextFiveAmKst(timestamp: string): string {
  const now = new Date(timestamp);
  const kstNowMs = now.getTime() + KST_OFFSET_MS;
  const kstNow = new Date(kstNowMs);
  let candidateKstMs = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate(),
    5,
    0,
    0,
    0
  );

  if (candidateKstMs <= kstNowMs) {
    candidateKstMs += ONE_DAY_MS;
  }

  return new Date(candidateKstMs - KST_OFFSET_MS).toISOString();
}

function nextCheckAtForCadence(timestamp: string, cadence: TrackingCadence): string {
  return cadence === 'Hourly' ? nextTopOfHour(timestamp) : nextFiveAmKst(timestamp);
}

function isRejectedResolvedQuery(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^error\s*:/i.test(value.trim());
}

function buildFallbackTrackingQuery(effectiveContext: ValidationEffectiveContext): string | null {
  const parts =
    effectiveContext.sourceType === 'event'
      ? [
          effectiveContext.searchArtist,
          effectiveContext.searchEvent,
          effectiveContext.searchItem,
          effectiveContext.searchLocation,
        ]
      : [
          effectiveContext.searchArtist,
          effectiveContext.searchAlbum ?? effectiveContext.searchItem,
          effectiveContext.searchLocation,
        ];

  const fallbackQuery = parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return fallbackQuery.length > 0 ? fallbackQuery : null;
}

function hasUsableTrackingQuery(effectiveContext: ValidationEffectiveContext): boolean {
  const resolvedSearchQuery = effectiveContext.resolvedSearchQuery?.trim() ?? null;
  if (resolvedSearchQuery && !isRejectedResolvedQuery(resolvedSearchQuery)) {
    return true;
  }

  const effectiveSearchQuery = effectiveContext.effectiveSearchQuery?.trim() ?? '';
  if (effectiveSearchQuery.length > 0 && !isRejectedResolvedQuery(effectiveSearchQuery)) {
    return true;
  }

  return buildFallbackTrackingQuery(effectiveContext) !== null;
}

function resolvePreferredSoldValue(
  researchValue: number | null,
  soldValue: number | null
): number | null {
  return researchValue ?? soldValue;
}

function hasResearchSoldEvidence(signals: ValidationRecommendationInput): boolean {
  return (
    signals.terapeak.provider === 'ebay_research_ui' &&
    (signals.terapeak.researchSoldPriceUsd !== null ||
      signals.terapeak.soldListingsCount !== null ||
      signals.terapeak.recentSoldCount7d !== null ||
      Object.values(signals.terapeak.soldVelocity).some((value) => value !== null))
  );
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
  weightedValidationScore?: WeightedScoreResult;
} {
  const dDay = request.validation.dDay;
  const baseCadence: TrackingCadence =
    typeof dDay === 'number' && dDay >= -3 && dDay <= 3 ? 'Hourly' : 'Daily';
  const hasRequiredSource =
    signals.effectiveContext.sourceType === 'event'
      ? Boolean(signals.effectiveContext.searchEvent ?? signals.effectiveContext.eventRecordId)
      : signals.effectiveContext.hasItem;
  const hasUsableQuery = hasUsableTrackingQuery(signals.effectiveContext);

  const shouldAutoTrack =
    request.validation.autoCheckEnabled &&
    request.validation.automationStatus === 'Watching' &&
    request.validation.buyDecision === 'Watching' &&
    hasRequiredSource &&
    hasUsableQuery;

  const trackingCadence: TrackingCadence = shouldAutoTrack ? baseCadence : 'Off';
  const nextCheckAt = !shouldAutoTrack ? null : nextCheckAtForCadence(request.timestamp, trackingCadence);

  const marketPrice =
    signals.terapeak.marketPriceUsd ??
    signals.sold.soldMedianPriceUsd ??
    signals.ebay.marketPriceUsd;
  const preorderListingsCount =
    signals.terapeak.preOrderListingsCount ?? signals.ebay.preOrderListingsCount;
  const wholesale = signals.effectiveContext.hasItem ? request.item.wholesalePrice : null;
  const marginRatio =
    marketPrice !== null && wholesale !== null && wholesale > 0
      ? (marketPrice - wholesale) / wholesale
      : null;
  const subjectLabel =
    signals.effectiveContext.sourceType === 'event'
      ? (signals.effectiveContext.searchEvent ??
        signals.effectiveContext.effectiveSearchQuery ??
        'event opportunity')
      : (signals.effectiveContext.searchAlbum ??
        signals.effectiveContext.searchItem ??
        request.item.name ??
        'release');
  const mergedSoldVelocity = {
    day1Sold: resolvePreferredSoldValue(
      signals.terapeak.soldVelocity.day1Sold,
      signals.sold.soldVelocity.day1Sold
    ),
    day2Sold: resolvePreferredSoldValue(
      signals.terapeak.soldVelocity.day2Sold,
      signals.sold.soldVelocity.day2Sold
    ),
    day3Sold: resolvePreferredSoldValue(
      signals.terapeak.soldVelocity.day3Sold,
      signals.sold.soldVelocity.day3Sold
    ),
  };
  const recentSoldCount = [
    mergedSoldVelocity.day1Sold,
    mergedSoldVelocity.day2Sold,
    mergedSoldVelocity.day3Sold,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const hasSoldProviderEvidence =
    signals.sold.soldMedianPriceUsd !== null ||
    signals.sold.soldResultsCount !== null ||
    Object.values(signals.sold.soldVelocity).some((value) => value !== null);
  const researchSoldEvidence = hasResearchSoldEvidence(signals);
  const effectiveSoldComparablePrice =
    (researchSoldEvidence ? signals.terapeak.researchSoldPriceUsd : null) ??
    signals.sold.soldMedianPriceUsd;
  const effectiveSoldConfidence = researchSoldEvidence
    ? signals.terapeak.confidence
    : hasSoldProviderEvidence
      ? signals.sold.confidence
      : 'Low';
  const hasUsableHistoricalResearch =
    signals.research.debug?.providerStatus !== undefined
      ? signals.research.debug.providerStatus === 'ok'
      : signals.research.previousAlbumTitle !== null ||
        signals.research.previousComebackFirstWeekSales !== null ||
        signals.research.perplexityHistoricalContextScore > 0;

  // ── Age-aware weighted scoring (threshold calibration) ─────────────────
  // Computes a weighted composite score that adjusts momentum/velocity emphasis
  // based on how many days the item has been tracked. New items (< 7 days)
  // get 70% momentum weight (since velocity data is sparse), while established
  // items get 70% velocity weight (since sales history is reliable).
  const weightedScore = shouldApplyAgeAwareCalibration(request)
    ? computeWeightedValidationScore(request, signals.momentumScore)
    : null;

  let latestAiRecommendation = 'Continue watching until stronger market signal appears.';
  let latestAiConfidence: 'High' | 'Medium' | 'Low' = 'Medium';
  let monitoringNotes = `Baseline recommendation generated from current ${signals.effectiveContext.mode} validation state for ${subjectLabel}.`;

  if (!shouldAutoTrack) {
    latestAiRecommendation =
      'Automatic tracking paused because the validation is no longer in a watchable state.';
    latestAiConfidence = 'High';
    monitoringNotes = !hasRequiredSource
      ? `Tracking was paused because the required ${signals.effectiveContext.sourceType} source context is missing for ${subjectLabel}.`
      : !hasUsableQuery
        ? `Tracking was paused because no valid search query could be derived for ${subjectLabel}.`
        : `External watch-state controls were not satisfied, so automation will not schedule another ${signals.effectiveContext.mode} validation run for ${subjectLabel}.`;
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
    effectiveSoldComparablePrice !== null &&
    recentSoldCount > 0 &&
    effectiveSoldConfidence !== 'Low'
  ) {
    latestAiRecommendation =
      'Recent sold comparables support real resale demand. Continue watching closely while waiting for a stronger conviction signal.';
    latestAiConfidence = effectiveSoldConfidence === 'High' ? 'High' : 'Medium';
    monitoringNotes =
      'Sold-item data confirms recent transaction activity, improving confidence while remaining conservative on buy-state changes.';
  } else if (effectiveSoldComparablePrice !== null) {
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

  if (hasUsableHistoricalResearch && signals.research.previousComebackFirstWeekSales !== null) {
    monitoringNotes += ` Previous comeback first-week sales reference: ${signals.research.previousComebackFirstWeekSales}.`;
  }

  if (hasUsableHistoricalResearch && signals.research.historicalContextNotes.length > 0) {
    monitoringNotes += ` Historical context (${signals.research.confidence}, score ${signals.research.perplexityHistoricalContextScore}/20): ${signals.research.historicalContextNotes}`;
  }

  // Append weighted scoring summary to monitoring notes if available
  if (weightedScore) {
    monitoringNotes +=
      `\nAge-weighted score: ${weightedScore.compositeScore}/100 (${weightedScore.classification}). ` +
      `Item type: ${weightedScore.isNewItem ? 'new (<7 days)' : 'established (>=7 days)'}. ` +
      `Weights: momentum ${Math.round(weightedScore.weights.momentum * 100)}%, ` +
      `velocity ${Math.round(weightedScore.weights.velocity * 100)}%. ` +
      `Effective thresholds — momentum BUY/Watch: ${weightedScore.effectiveThresholds.momentumBuy}/${weightedScore.effectiveThresholds.momentumWatch}, ` +
      `velocity BUY/Watch: ${weightedScore.effectiveThresholds.velocityBuy}/${weightedScore.effectiveThresholds.velocityWatch}.`;
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
    // Weighted scoring metadata (used by downstream Airtable formulas)
    weightedValidationScore: weightedScore ?? undefined,
  };
}
