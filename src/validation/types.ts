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

export interface SoldBucketDebug {
  status: 'ok' | 'partial' | 'skipped';
  notes: string[];
  totalItemsExamined: number;
  withSoldAt: number;
  missingSoldAt: number;
  dateParseFailures: number;
  futureDated: number;
  bucketedItems: number;
}

export interface SoldQueryDiagnostic {
  query: string;
  tier: number;
  family?: string;
  soldResultsCount: number | null;
  recentSoldCount7d: number | null;
  titleMatchScore: number | null;
  subtypeAligned?: boolean;
  tooNarrow?: boolean;
  status: 'ok' | 'error';
  note?: string;
}

export interface ResearchQueryDiagnostic {
  query: string;
  tier: number;
  family?: string;
  activeListings: number | null;
  soldTotal: number | null;
  avgWatchersPerListing: number | null;
  watcherCoverageCount: number | null;
  sellThroughPct: number | null;
  titleMatchScore: number | null;
  subtypeAligned?: boolean;
  tooNarrow?: boolean;
  score: number | null;
  status: 'ok' | 'error';
  note?: string;
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
  directSearchQuery?: string | null;
  resolvedSearchArtist?: string | null;
  resolvedSearchItem?: string | null;
  resolvedSearchEvent?: string | null;
  resolvedSearchLocation?: string | null;
  resolvedSearchQuery?: string | null;
  validationScope?: string | null;
  queryScope?: string | null;
}

export interface ValidationEffectiveContext {
  sourceType: 'item' | 'event';
  mode: 'item' | 'event';
  validationScope: string | null;
  queryScope: string | null;
  directQueryActive: boolean;
  resolvedSearchQuery: string | null;
  effectiveSearchQuery: string | null;
  searchArtist: string | null;
  searchAlbum: string | null;
  searchItem: string | null;
  searchEvent: string | null;
  searchLocation: string | null;
  hasItem: boolean;
  hasEvent: boolean;
  itemRecordId: string | null;
  eventRecordId: string | null;
  itemName: string | null;
  eventDate: string | null;
  dDay: number | null;
  requestTimestamp: string;
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
  effectiveContext?: ValidationEffectiveContext;
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
  recentSoldCount7d?: number | null;
  soldBucketDebug?: SoldBucketDebug;
  query: string | null;
  queryCandidates?: string[];
  queryDiagnostics?: SoldQueryDiagnostic[];
  selectedQuery?: string;
  selectedQueryTier?: number | null;
  selectedQueryFamily?: string | null;
  broadAlbumQuery?: string | null;
  subtypeSpecificQuery?: string | null;
  querySelectionReason?: string;
  responseUrl: string | null;
  status: 'ok' | 'unavailable' | 'error' | 'skipped';
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
      rawItemTitleInput?: string;
      rawSocialQueryInput?: string;
      normalizedSocialQueryBase?: string;
      strippedVariationTerms?: string[];
      variationStripNote?: string;
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
      rawItemTitleInput?: string;
      rawSocialQueryInput?: string;
      normalizedSocialQueryBase?: string;
      strippedVariationTerms?: string[];
      variationStripNote?: string;
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
      rawItemTitleInput?: string;
      rawSocialQueryInput?: string;
      normalizedSocialQueryBase?: string;
      strippedVariationTerms?: string[];
      variationStripNote?: string;
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
  researchSoldPriceUsd: number | null;
  avgShippingCostUsd: number | null;
  competitionLevel: number | null;
  previousPobAvgPriceUsd: number | null;
  previousPobSellThroughPct: number | null;
  currentListingsCount: number | null;
  soldListingsCount: number | null;
  soldVelocity: ValidationSoldVelocity;
  recentSoldCount7d?: number | null;
  soldBucketDebug?: SoldBucketDebug;
  provider: 'terapeak' | 'ebay_research_ui' | 'none';
  confidence: ValidationSignalConfidence;
  queryDebug: {
    currentQuery?: string | null;
    previousPobQuery?: string | null;
    currentQueryFamily?: string | null;
    previousPobQueryFamily?: string | null;
    selectedMode?: 'current_market' | 'previous_pob' | 'combined' | null;
    currentResultCount?: number | null;
    previousPobResultCount?: number | null;
    notes?: string | null;
    queryResolution?: ProviderQueryResolutionDebug;
    currentModulesSeen?: string[];
    previousPobModulesSeen?: string[];
    currentPageErrors?: string[];
    previousPobPageErrors?: string[];
    currentActiveEndpointUrl?: string | null;
    currentSoldEndpointUrl?: string | null;
    previousPobActiveEndpointUrl?: string | null;
    previousPobSoldEndpointUrl?: string | null;
    authState?: 'loaded' | 'authenticated' | 'missing' | 'expired' | 'unavailable';
    sessionStrategy?: 'env_cookies' | 'kv_store' | 'storage_state' | 'playwright_profile' | 'none';
    sessionSource?:
      | 'cloudflare_kv'
      | 'upstash-redis'
      | 'filesystem'
      | 'env'
      | 'playwright_profile'
      | 'none'
      | null;
    sessionStoreConfigured?: 'cloudflare_kv' | 'upstash-redis' | 'filesystem' | 'none';
    sessionStoreSelected?: 'cloudflare_kv' | 'upstash-redis' | 'filesystem' | 'none';
    kvLoadAttempted?: boolean;
    kvLoadSucceeded?: boolean;
    cfKvLoadAttempted?: boolean;
    cfKvLoadSucceeded?: boolean;
    upstashLoadAttempted?: boolean;
    upstashLoadSucceeded?: boolean;
    kvStorageStateBytes?: number | null;
    storageStateBytes?: number | null;
    envLoadAttempted?: boolean;
    envLoadSucceeded?: boolean;
    filesystemLoadAttempted?: boolean;
    filesystemLoadSucceeded?: boolean;
    profileLoadAttempted?: boolean;
    profileLoadSucceeded?: boolean;
    authValidationAttempted?: boolean;
    authValidationSucceeded?: boolean;
    candidateDiagnostics?: ResearchQueryDiagnostic[];
    previousPobCandidateDiagnostics?: ResearchQueryDiagnostic[];
    currentWatcherCoverageCount?: number | null;
    previousPobWatcherCoverageCount?: number | null;
    fallbackReasons?: string[];
    writeSources?: Record<string, string>;
  };
}

export interface PreviousComebackResearchSignals {
  previousAlbumTitle: string | null;
  previousComebackFirstWeekSales: number | null;
  perplexityHistoricalContextScore: number;
  historicalContextNotes: string;
  confidence: ValidationSignalConfidence;
  notes: string;
  sources?: string[];
  debug?: {
    providerStatus: 'ok' | 'unconfigured' | 'no_evidence' | 'error';
    parseStatus: 'ok' | 'fallback' | 'error' | 'unconfigured';
    query: string | null;
    promptFocus: string[];
    citations: string[];
    sourceSnippets: string[];
    resolvedPriorRelease: string | null;
    extractedConfidence: ValidationSignalConfidence | null;
    computedConfidence: ValidationSignalConfidence;
    confidenceReason: string | null;
    scoreAssignmentReason: string;
    rawResponseText?: string | null;
    errorMessage?: string | null;
  };
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
  perplexityHistoricalContextScore?: number;
  historicalContextNotes?: string;
  researchConfidence?: ValidationSignalConfidence;
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
