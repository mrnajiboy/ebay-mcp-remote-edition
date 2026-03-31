export type TrackingCadence = 'Daily' | 'Hourly' | 'Off';

export type ValidationSignalConfidence = 'High' | 'Medium' | 'Low';

export interface ValidationSoldVelocity {
  day1Sold: number | null;
  day2Sold: number | null;
  day3Sold: number | null;
  day4Sold: number | null;
  day5Sold: number | null;
  daysTracked: number | null;
}

export interface ValidationCurrentMetrics {
  avgWatchersPerListing: number | null;
  preOrderListingsCount: number | null;
  twitterTrending: boolean;
  youtubeViews24hMillions: number | null;
  redditPostsCount7d: number | null;
  marketPriceUsd: number | null;
  avgShippingCostUsd: number | null;
  competitionLevel: number | null;
  marketPriceTrend: string;
  day1Sold: number | null;
  day2Sold: number | null;
  day3Sold: number | null;
  day4Sold: number | null;
  day5Sold: number | null;
  daysTracked: number | null;
}

export interface ValidationRunRequest {
  validationId: string;
  runType: 'scheduled' | 'manual';
  cadence: TrackingCadence;
  timestamp: string;
  item: {
    recordId: string;
    name: string;
    variation: string[];
    itemType: string[];
    releaseType: string[];
    releaseDate: string | null;
    releasePeriod: string[];
    availability: string[];
    wholesalePrice: number | null;
    supplierNames: string[];
    canonicalArtists: string[];
    relatedAlbums: string[];
  };
  validation: {
    validationType: string;
    buyDecision: string;
    automationStatus: string;
    autoCheckEnabled: boolean;
    dDay: number | null;
    artistTier: string;
    initialBudget: number | null;
    reserveBudget: number | null;
    currentMetrics: ValidationCurrentMetrics;
  };
}

export interface EbayValidationSignals {
  avgWatchersPerListing: number | null;
  preOrderListingsCount: number | null;
  marketPriceUsd: number | null;
  avgShippingCostUsd: number | null;
  competitionLevel: number | null;
  marketPriceTrend: string;
  ebayQuery: string;
  queryCandidates?: string[];
  selectedQuery?: string;
  selectedQueryTier?: number | null;
  sampleSize: number;
  soldVelocity: ValidationSoldVelocity;
}

export interface SoldItemSample {
  title: string;
  soldAt: string | null;
  priceUsd: number | null;
  itemUrl: string | null;
}

export interface EbaySoldValidationSignals {
  provider: string;
  confidence: ValidationSignalConfidence;
  soldResultsCount: number | null;
  soldAveragePriceUsd: number | null;
  soldMedianPriceUsd: number | null;
  soldMinPriceUsd: number | null;
  soldMaxPriceUsd: number | null;
  soldItemsSample: SoldItemSample[];
  soldVelocity: ValidationSoldVelocity;
  query: string | null;
  queryCandidates?: string[];
  selectedQuery?: string;
  selectedQueryTier?: number | null;
  responseUrl: string | null;
  status: 'ok' | 'unavailable' | 'error';
  errorMessage?: string;
}

export interface SocialValidationSignals {
  twitterTrending: boolean | null;
  youtubeViews24hMillions: number | null;
  redditPostsCount7d: number | null;
  debug?: {
    twitter?: {
      checked: boolean;
      query?: string;
      searchUrl?: string;
      recentResultCount?: number | null;
      confidence?: ValidationSignalConfidence;
      note?: string;
    };
    youtube?: {
      checked: boolean;
      query?: string;
      searchUrl?: string;
      topVideoTitle?: string | null;
      topVideoUrl?: string | null;
      publishedAt?: string | null;
      totalViews?: number | null;
      daysLive?: number | null;
      avgDailyViews?: number | null;
      confidence?: ValidationSignalConfidence;
      note?: string;
    };
    reddit?: {
      checked: boolean;
      query?: string;
      searchUrl?: string;
      recentResultCount?: number | null;
      confidence?: ValidationSignalConfidence;
      note?: string;
    };
  };
}

export interface TerapeakValidationSignals {
  avgWatchersPerListing: number | null;
  preOrderListingsCount: number | null;
  marketPriceUsd: number | null;
  avgShippingCostUsd: number | null;
  competitionLevel: number | null;
  previousPobAvgPriceUsd: number | null;
  previousPobSellThroughPct: number | null;
  currentListingsCount: number | null;
  soldListingsCount: number | null;
  provider: 'terapeak' | 'ebay_research_ui' | 'none';
  confidence: ValidationSignalConfidence;
  queryDebug: {
    currentQuery?: string | null;
    previousPobQuery?: string | null;
    selectedMode?: 'current_market' | 'previous_pob' | 'combined' | null;
    currentResultCount?: number | null;
    previousPobResultCount?: number | null;
    notes?: string | null;
  };
}

export interface PreviousComebackResearchSignals {
  previousAlbumTitle: string | null;
  previousComebackFirstWeekSales: number | null;
  confidence: ValidationSignalConfidence;
  notes: string;
  sources?: string[];
}

export interface ChartValidationSignals {
  chartMomentum?: string | null;
}

export interface ValidationWrites {
  avgWatchersPerListing?: number | null;
  preOrderListingsCount?: number | null;
  twitterTrending?: boolean;
  youtubeViews24hMillions?: number | null;
  redditPostsCount7d?: number | null;
  marketPriceUsd?: number | null;
  avgShippingCostUsd?: number | null;
  competitionLevel?: number | null;
  marketPriceTrend?: string;
  day1Sold?: number | null;
  day2Sold?: number | null;
  day3Sold?: number | null;
  day4Sold?: number | null;
  day5Sold?: number | null;
  daysTracked?: number | null;
  previousPobAvgPriceUsd?: number | null;
  previousPobSellThroughPct?: number | null;
  previousComebackFirstWeekSales?: number | null;
  monitoringNotes?: string;
  lastDataSnapshot?: string;
  latestAiRecommendation?: string;
  latestAiConfidence?: ValidationSignalConfidence;
  validationError?: string;
}

export interface ValidationDecision {
  buyDecision?: string;
  automationStatus?: string;
  trackingCadence?: TrackingCadence;
  shouldAutoTrack?: boolean;
  nextCheckAt?: string | null;
}

export interface ValidationRunResponse {
  status: 'ok' | 'error';
  validationId: string;
  writes?: ValidationWrites;
  decision?: ValidationDecision;
  debug?: Record<string, unknown>;
  errorCode?: string;
  message?: string;
  retryable?: boolean;
  nextCheckAt?: string | null;
}
