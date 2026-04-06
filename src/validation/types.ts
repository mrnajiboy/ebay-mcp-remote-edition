export type TrackingCadence = 'Daily' | 'Hourly' | 'Off';

export type ValidationSignalConfidence = 'High' | 'Medium' | 'Low';

export type YouTubeCandidateClass = 'official_release' | 'branded_media' | 'fallback_adjacent';

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

export interface ValidationQueryContext {
  directQueryActive?: boolean | null;
  resolvedSearchQuery?: string | null;
  validationScope?: string | null;
  queryScope?: string | null;
}

export interface ValidationSourceContext {
  sourceType?: 'item' | 'event';
  hasItem?: boolean;
  hasEvent?: boolean;
  itemRecordId?: string | null;
  eventRecordId?: string | null;
}

export interface ValidationItem {
  recordId: string | null;
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
}

export interface ProviderQueryResolutionDebug {
  queryContextUsed: boolean;
  querySource: 'resolved_query_context' | 'provider_fallback';
  resolvedSearchQuery: string | null;
  validationScope: string | null;
  queryScope: string | null;
}

export interface ValidationRunRequest {
  validationId: string;
  runType: 'scheduled' | 'manual';
  cadence: TrackingCadence;
  timestamp: string;
  sourceContext?: ValidationSourceContext;
  item: ValidationItem;
  validation: {
    validationType: string;
    buyDecision: string;
    automationStatus: string;
    autoCheckEnabled: boolean;
    dDay: number | null;
    artistTier: string;
    initialBudget: number | null;
    reserveBudget: number | null;
    queryContext?: ValidationQueryContext;
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
  queryDiagnostics?: {
    query: string;
    tier: number;
    family?: string;
    itemSummaryCount: number;
    totalListings: number;
  }[];
  selectionReason?: string;
  errorMessage?: string;
  responseStatus?: number | null;
  responseBodyExcerpt?: string | null;
  sampleSize: number;
  soldVelocity: ValidationSoldVelocity;
  queryResolution?: ProviderQueryResolutionDebug;
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
  queryDiagnostics?: {
    query: string;
    tier: number;
    family?: string;
    soldResultsCount: number | null;
    status: 'ok' | 'error';
    note?: string;
  }[];
  selectedQuery?: string;
  selectedQueryTier?: number | null;
  responseUrl: string | null;
  status: 'ok' | 'unavailable' | 'error';
  errorMessage?: string;
  queryResolution?: ProviderQueryResolutionDebug;
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
      queryCandidates?: string[];
      selectedQuery?: string;
      totalTweetCount?: number | null;
      granularity?: 'minute' | 'hour' | 'day';
      queryDiagnostics?: {
        query: string;
        family?: string;
        totalTweetCount: number | null;
        responseStatus?: number | null;
        note?: string;
      }[];
      recentResultCount?: number | null;
      confidence?: ValidationSignalConfidence;
      note?: string;
      queryResolution?: ProviderQueryResolutionDebug;
    };
    youtube?: {
      checked: boolean;
      query?: string;
      searchUrl?: string;
      queryCandidates?: string[];
      selectedQuery?: string;
      selectedCandidateClass?: YouTubeCandidateClass | null;
      resultsExamined?: number;
      queryDiagnostics?: {
        query: string;
        family?: string;
        resultCount: number;
        topVideoTitles: string[];
      }[];
      selectedVideoId?: string | null;
      selectedVideoTitle?: string | null;
      selectedVideoUrl?: string | null;
      selectedVideoViews?: number | null;
      selectedVideoPublishedAt?: string | null;
      selectedVideoDaysLive?: number | null;
      selectedVideoAvgDailyViews?: number | null;
      candidateVideos?: {
        videoId: string;
        title: string | null;
        url: string;
        channelTitle: string | null;
        totalViews: number | null;
        publishedAt: string | null;
        avgDailyViews: number | null;
        relevanceScore: number;
        matchedQueries: string[];
        candidateClass?: YouTubeCandidateClass;
        selectedByClass?: boolean;
        officialReleaseScore?: number;
        officialTitleSignal?: boolean;
        officialChannelSignal?: boolean;
        brandedChannelSignal?: boolean;
        demotedTitleSignal?: boolean;
        demotedChannelSignal?: boolean;
        shortsPenalty?: boolean;
        artistAlignment?: boolean;
        albumPhraseAlignment?: boolean;
        albumKeywordMatches?: number;
        queryMatchCount?: number;
      }[];
      topVideoTitle?: string | null;
      topVideoUrl?: string | null;
      publishedAt?: string | null;
      totalViews?: number | null;
      daysLive?: number | null;
      avgDailyViews?: number | null;
      confidence?: ValidationSignalConfidence;
      note?: string;
      queryResolution?: ProviderQueryResolutionDebug;
    };
    reddit?: {
      checked: boolean;
      query?: string;
      searchUrl?: string;
      queryCandidates?: string[];
      selectedQuery?: string;
      queryDiagnostics?: {
        query: string;
        family?: string;
        recentResultCount?: number | null;
        pageLimitReached?: boolean | null;
        note?: string;
      }[];
      recentResultCount?: number | null;
      pageLimit?: number;
      pageLimitReached?: boolean | null;
      confidence?: ValidationSignalConfidence;
      note?: string;
      queryResolution?: ProviderQueryResolutionDebug;
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
    queryResolution?: ProviderQueryResolutionDebug;
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
