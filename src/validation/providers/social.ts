import axios from 'axios';
import type {
  SocialValidationSignals,
  ValidationRunRequest,
  ValidationSignalConfidence,
  YouTubeCandidateClass,
} from '../types.js';
import {
  buildConversationAlbumPhrase,
  buildResolvedRedditQueryPlan,
  buildResolvedTwitterQueryPlan,
  buildResolvedYouTubeQueryPlan,
  extractSemanticTokens,
  getPrimaryAlbumPhrase,
  getPrimarySocialAlbumPhrase,
  getSocialQueryContextDebug,
  normalizeWhitespace,
} from './query-utils.js';
import type { ProviderQueryCandidate } from './query-utils.js';
import { getValidationEffectiveContext } from '../effective-context.js';

type ResolvedQueryPlanBuilder = (request: ValidationRunRequest) => unknown;
type RequestStringBuilder = (request: ValidationRunRequest) => unknown;
type StringBuilder = (value: string) => unknown;

const buildResolvedTwitterQueryPlanSafe =
  buildResolvedTwitterQueryPlan as unknown as ResolvedQueryPlanBuilder;
const buildResolvedYouTubeQueryPlanSafe =
  buildResolvedYouTubeQueryPlan as unknown as ResolvedQueryPlanBuilder;
const buildResolvedRedditQueryPlanSafe =
  buildResolvedRedditQueryPlan as unknown as ResolvedQueryPlanBuilder;
const getPrimaryAlbumPhraseSafe = getPrimaryAlbumPhrase as unknown as RequestStringBuilder;
const getPrimarySocialAlbumPhraseSafe =
  getPrimarySocialAlbumPhrase as unknown as RequestStringBuilder;
const extractSemanticTokensSafe = extractSemanticTokens as unknown as StringBuilder;
const buildConversationAlbumPhraseSafe = buildConversationAlbumPhrase as unknown as StringBuilder;

interface TwitterRecentCountsResponse {
  data?: {
    start?: string;
    end?: string;
    tweet_count?: number;
  }[];
  meta?: {
    total_tweet_count?: number;
  };
}

interface YouTubeSearchResponse {
  items?: {
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string };
  }[];
}

interface YouTubeVideosResponse {
  items?: {
    id?: string;
    snippet?: { title?: string; publishedAt?: string; channelTitle?: string };
    statistics?: { viewCount?: string };
  }[];
}

interface RedditSearchResponse {
  data?: {
    children?: unknown[];
  };
}

interface YouTubeSearchCandidate {
  videoId: string;
  title: string | null;
  channelTitle: string | null;
  matchedQueries: string[];
}

interface RankedYouTubeCandidate {
  videoId: string;
  title: string | null;
  channelTitle: string | null;
  matchedQueries: string[];
  totalViews: number | null;
  publishedAt: string | null;
  daysLive: number | null;
  avgDailyViews: number | null;
  relevanceScore: number;
  rankingSignals: {
    candidateClass: YouTubeCandidateClass;
    officialTitleSignal: boolean;
    officialChannelSignal: boolean;
    brandedChannelSignal: boolean;
    demotedTitleSignal: boolean;
    demotedChannelSignal: boolean;
    shortsPenalty: boolean;
    artistAlignment: boolean;
    albumPhraseAlignment: boolean;
    albumKeywordMatches: number;
    queryMatchCount: number;
    officialReleaseScore: number;
  };
}

interface TwitterQueryDiagnostic {
  query: string;
  family?: string;
  totalTweetCount: number | null;
  responseStatus?: number | null;
  note?: string;
}

interface YouTubeQueryDiagnostic {
  query: string;
  family?: string;
  resultCount: number;
  topVideoTitles: string[];
}

interface RedditQueryDiagnostic {
  query: string;
  family?: string;
  recentResultCount?: number | null;
  pageLimitReached?: boolean | null;
  endpointTried?: string;
  alternateEndpointTried?: string | null;
  statusCode?: number | null;
  userAgentUsed?: string;
  note?: string;
}

interface RedditSearchCountFailureContext {
  endpointTried: string;
  alternateEndpointTried: string | null;
  statusCode: number | null;
  userAgentUsed: string;
  note: string;
}

class RedditSearchCountError extends Error {
  readonly endpointTried: string;
  readonly alternateEndpointTried: string | null;
  readonly statusCode: number | null;
  readonly userAgentUsed: string;

  constructor(context: RedditSearchCountFailureContext) {
    super(context.note);
    this.name = 'RedditSearchCountError';
    this.endpointTried = context.endpointTried;
    this.alternateEndpointTried = context.alternateEndpointTried;
    this.statusCode = context.statusCode;
    this.userAgentUsed = context.userAgentUsed;
  }
}

interface TwitterDebug {
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
  queryDiagnostics?: TwitterQueryDiagnostic[];
  recentResultCount?: number | null;
  confidence?: ValidationSignalConfidence;
  note?: string;
  queryResolution?: QueryResolutionDebug;
}

interface YouTubeCandidateDebug {
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
}

interface YouTubeDebug {
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
  queryDiagnostics?: YouTubeQueryDiagnostic[];
  selectedVideoId?: string | null;
  selectedVideoTitle?: string | null;
  selectedVideoUrl?: string | null;
  selectedVideoViews?: number | null;
  selectedVideoPublishedAt?: string | null;
  selectedVideoDaysLive?: number | null;
  selectedVideoAvgDailyViews?: number | null;
  candidateVideos?: YouTubeCandidateDebug[];
  topVideoTitle?: string | null;
  topVideoUrl?: string | null;
  publishedAt?: string | null;
  totalViews?: number | null;
  daysLive?: number | null;
  avgDailyViews?: number | null;
  confidence?: ValidationSignalConfidence;
  note?: string;
  queryResolution?: QueryResolutionDebug;
}

interface RedditDebug {
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
  queryDiagnostics?: RedditQueryDiagnostic[];
  recentResultCount?: number | null;
  pageLimit?: number;
  pageLimitReached?: boolean | null;
  endpointTried?: string;
  alternateEndpointTried?: string | null;
  statusCode?: number | null;
  userAgentUsed?: string;
  confidence?: ValidationSignalConfidence;
  note?: string;
  queryResolution?: QueryResolutionDebug;
}

interface SocialValidationDebugState {
  twitter: TwitterDebug;
  youtube: YouTubeDebug;
  reddit: RedditDebug;
}

interface QueryResolutionDebug {
  queryContextUsed: boolean;
  querySource: 'resolved_query_context' | 'provider_fallback';
  resolvedSearchQuery: string | null;
  validationScope: string | null;
  queryScope: string | null;
}

interface ResolvedProviderQueryPlanLike {
  queryPlan: ProviderQueryCandidate[];
  queryResolution: QueryResolutionDebug;
}

type TwitterQueryDiagnostics = TwitterQueryDiagnostic[];
type YouTubeQueryDiagnostics = YouTubeQueryDiagnostic[];
type RedditQueryDiagnostics = RedditQueryDiagnostic[];

const REDDIT_PAGE_LIMIT = 100;
const REDDIT_PRIMARY_ENDPOINT = 'https://www.reddit.com/search.json';
const REDDIT_FALLBACK_ENDPOINT = 'https://old.reddit.com/search.json';
const DEFAULT_REDDIT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 ebay-mcp-validation/1.0';
const REDDIT_ACCEPT_HEADER = 'application/json,text/javascript,*/*;q=0.01';
const REDDIT_ACCEPT_LANGUAGE_HEADER = 'en-US,en;q=0.9';
const YOUTUBE_SEARCH_MAX_RESULTS = 50;
const YOUTUBE_MAX_CANDIDATE_VIDEOS = 100;
const YOUTUBE_VIDEOS_DETAILS_BATCH_SIZE = 50;
const TWITTER_COUNTS_GRANULARITY = 'day' as const;
const TWITTER_TRENDING_THRESHOLD = 100;
const YOUTUBE_OFFICIAL_TITLE_PATTERN =
  /\bofficial\b|\bmv\b|music video|official audio|teaser|concept|highlight medley|performance|special video|visualizer/;
const YOUTUBE_DEMOTED_TITLE_PATTERN =
  /unboxing|shop\b|store\b|merch|haul|reaction|cover|fan cam|fancam|reseller|resale|vinyl|\blp\b|\bcd\b|photocard|pob\b|digipack|platform|jewel|standard\s+ver(?:sion)?|album\s+preview/;
const YOUTUBE_SHORTS_PATTERN = /shorts?\b/;
const YOUTUBE_OFFICIAL_CHANNEL_PATTERN = /\bofficial\b|\btopic\b/;
const YOUTUBE_BRANDED_CHANNEL_PATTERN = /entertainment|music|records|labels?|media|studio|vevo/;
const YOUTUBE_DEMOTED_CHANNEL_PATTERN =
  /shop\b|store\b|merch|reseller|resale|unboxing|fan\b|collector|trading|market/;

function getPrimaryArtist(request: ValidationRunRequest): string {
  return (
    getValidationEffectiveContext(request).searchArtist ??
    request.item.canonicalArtists[0]?.trim() ??
    ''
  );
}

function buildTwitterCountsUrl(query: string): string {
  return `https://api.x.com/2/tweets/counts/recent?query=${encodeURIComponent(query)}`;
}

function buildYouTubeSearchUrl(query: string): string {
  return `https://www.googleapis.com/youtube/v3/search?q=${encodeURIComponent(query)}`;
}

function buildYouTubeVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function buildRedditSearchUrl(endpoint: string, query: string, pageLimit: number): string {
  return `${endpoint}?q=${encodeURIComponent(query)}&sort=new&t=week&limit=${pageLimit}`;
}

function getConfidenceFromCount(count: number): ValidationSignalConfidence {
  if (count >= 20) return 'High';
  if (count >= 5) return 'Medium';
  return 'Low';
}

function getYouTubeConfidence(avgDailyViews: number | null): ValidationSignalConfidence {
  if ((avgDailyViews ?? 0) >= 500_000) return 'High';
  if ((avgDailyViews ?? 0) >= 100_000) return 'Medium';
  return 'Low';
}

function getDaysLive(publishedAt: string | null): number | null {
  const publishedDate = publishedAt ? new Date(publishedAt) : null;
  if (!publishedDate || !Number.isFinite(publishedDate.getTime())) {
    return null;
  }

  return Math.max(1, Math.floor((Date.now() - publishedDate.getTime()) / (24 * 60 * 60 * 1000)));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function isProviderQueryCandidate(value: unknown): value is ProviderQueryCandidate {
  return (
    typeof value === 'object' &&
    value !== null &&
    'family' in value &&
    'query' in value &&
    typeof value.family === 'string' &&
    typeof value.query === 'string'
  );
}

function asProviderQueryCandidates(value: unknown): ProviderQueryCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isProviderQueryCandidate);
}

function normalizeQueryResolution(value: unknown): QueryResolutionDebug {
  if (typeof value !== 'object' || value === null) {
    return {
      queryContextUsed: false,
      querySource: 'provider_fallback',
      resolvedSearchQuery: null,
      validationScope: null,
      queryScope: null,
    };
  }

  const resolutionRecord = value as Record<string, unknown>;

  return {
    queryContextUsed: resolutionRecord.queryContextUsed === true,
    querySource:
      resolutionRecord.querySource === 'resolved_query_context'
        ? 'resolved_query_context'
        : 'provider_fallback',
    resolvedSearchQuery: asString(resolutionRecord.resolvedSearchQuery),
    validationScope: asString(resolutionRecord.validationScope),
    queryScope: asString(resolutionRecord.queryScope),
  };
}

function normalizeResolvedQueryPlan(value: unknown): ResolvedProviderQueryPlanLike {
  if (typeof value !== 'object' || value === null) {
    return {
      queryPlan: [],
      queryResolution: normalizeQueryResolution(null),
    };
  }

  const planRecord = value as Record<string, unknown>;

  return {
    queryPlan: asProviderQueryCandidates(planRecord.queryPlan),
    queryResolution: normalizeQueryResolution(planRecord.queryResolution),
  };
}

function getPrimaryAlbumPhraseValue(request: ValidationRunRequest): string {
  return asString(getPrimaryAlbumPhraseSafe(request)) ?? '';
}

function getPrimarySocialAlbumPhraseValue(request: ValidationRunRequest): string {
  return asString(getPrimarySocialAlbumPhraseSafe(request)) ?? '';
}

function extractSemanticTokenValues(value: string): string[] {
  return asStringArray(extractSemanticTokensSafe(value));
}

function buildConversationAlbumPhraseValue(value: string): string {
  return asString(buildConversationAlbumPhraseSafe(value)) ?? '';
}

function roundMillions(value: number | null): number | null {
  return value !== null ? Math.round((value / 1_000_000) * 1000) / 1000 : null;
}

function scoreYouTubeCandidate(
  candidate: RankedYouTubeCandidate,
  primaryArtist: string,
  albumPhrase: string,
  albumKeywords: string[]
): RankedYouTubeCandidate['rankingSignals'] & { score: number } {
  const title = normalizeWhitespace(candidate.title ?? '').toLowerCase();
  const channelTitle = normalizeWhitespace(candidate.channelTitle ?? '').toLowerCase();
  const combinedText = `${title} ${channelTitle}`;
  const normalizedArtist = normalizeWhitespace(primaryArtist).toLowerCase();
  const normalizedAlbumPhrase = buildConversationAlbumPhraseValue(albumPhrase).toLowerCase();
  const albumMatches = albumKeywords.filter((keyword) => combinedText.includes(keyword)).length;
  const hasOfficialSignal = YOUTUBE_OFFICIAL_TITLE_PATTERN.test(title);
  const hasOfficialChannelSignal = YOUTUBE_OFFICIAL_CHANNEL_PATTERN.test(channelTitle);
  const hasBrandedChannelSignal = YOUTUBE_BRANDED_CHANNEL_PATTERN.test(channelTitle);
  const hasDemotedTitleSignal = YOUTUBE_DEMOTED_TITLE_PATTERN.test(title);
  const hasShortsSignal = YOUTUBE_SHORTS_PATTERN.test(title);
  const hasDemotedChannelSignal = YOUTUBE_DEMOTED_CHANNEL_PATTERN.test(channelTitle);
  const channelContainsArtist =
    normalizedArtist.length > 0 && channelTitle.includes(normalizedArtist);
  const hasAlbumPhraseMatch =
    normalizedAlbumPhrase.length > 0 && combinedText.includes(normalizedAlbumPhrase);
  const hasArtistAlignment = normalizedArtist.length > 0 && combinedText.includes(normalizedArtist);
  const queryMatchBoost = candidate.matchedQueries.length * 10;
  const viewSignal =
    candidate.totalViews !== null ? Math.min(10, Math.log10(candidate.totalViews + 1)) : 0;
  const freshnessSignal =
    candidate.daysLive !== null ? Math.max(0, 16 - Math.log2(candidate.daysLive + 1) * 2) : 0;
  const officialReleaseScore =
    (hasOfficialSignal ? 120 : 0) +
    (hasOfficialChannelSignal ? 140 : 0) +
    (hasBrandedChannelSignal && channelContainsArtist ? 55 : 0) +
    (hasAlbumPhraseMatch ? 40 : 0) +
    albumMatches * 16 -
    (hasDemotedTitleSignal ? 150 : 0) -
    (hasShortsSignal ? 90 : 0) -
    (hasDemotedChannelSignal ? 110 : 0);
  const candidateClass: YouTubeCandidateClass =
    hasDemotedTitleSignal || hasShortsSignal || hasDemotedChannelSignal
      ? 'fallback_adjacent'
      : hasOfficialSignal || hasOfficialChannelSignal
        ? 'official_release'
        : (hasBrandedChannelSignal || channelContainsArtist) &&
            (hasArtistAlignment || hasAlbumPhraseMatch || albumMatches > 0)
          ? 'branded_media'
          : 'fallback_adjacent';
  const score =
    officialReleaseScore +
    (candidateClass === 'official_release' ? 220 : candidateClass === 'branded_media' ? 95 : 0) +
    (hasArtistAlignment ? 120 : 0) +
    (hasAlbumPhraseMatch ? 65 : 0) +
    albumMatches * 20 +
    queryMatchBoost +
    viewSignal +
    freshnessSignal;

  return {
    candidateClass,
    officialTitleSignal: hasOfficialSignal,
    officialChannelSignal: hasOfficialChannelSignal,
    brandedChannelSignal: hasBrandedChannelSignal,
    demotedTitleSignal: hasDemotedTitleSignal,
    demotedChannelSignal: hasDemotedChannelSignal,
    shortsPenalty: hasShortsSignal,
    artistAlignment: hasArtistAlignment,
    albumPhraseAlignment: hasAlbumPhraseMatch,
    albumKeywordMatches: albumMatches,
    queryMatchCount: candidate.matchedQueries.length,
    officialReleaseScore,
    score,
  };
}

function getYouTubeCandidateClassRank(candidateClass: YouTubeCandidateClass): number {
  switch (candidateClass) {
    case 'official_release':
      return 0;
    case 'branded_media':
      return 1;
    case 'fallback_adjacent':
      return 2;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAxiosFailureDebug(error: unknown): {
  responseStatus: number | null;
  note: string;
} {
  if (!axios.isAxiosError(error)) {
    return {
      responseStatus: null,
      note: getErrorMessage(error),
    };
  }

  return {
    responseStatus: error.response?.status ?? null,
    note: getErrorMessage(error),
  };
}

function getQueryCandidates(queryPlan: ProviderQueryCandidate[]): string[] {
  return queryPlan.map((candidate) => candidate.query);
}

function cloneQueryResolution(queryResolution: QueryResolutionDebug): QueryResolutionDebug {
  return {
    queryContextUsed: queryResolution.queryContextUsed,
    querySource: queryResolution.querySource,
    resolvedSearchQuery: queryResolution.resolvedSearchQuery,
    validationScope: queryResolution.validationScope,
    queryScope: queryResolution.queryScope,
  };
}

function getQueryPlanFamily(
  queryPlan: ProviderQueryCandidate[],
  index: number
): string | undefined {
  return queryPlan.at(index)?.family;
}

async function fetchRedditSearchCount(
  query: string,
  pageLimit: number,
  userAgent: string
): Promise<{
  recentResultCount: number;
  pageLimitReached: boolean;
  endpointTried: string;
  alternateEndpointTried: string | null;
  statusCode: number | null;
  userAgentUsed: string;
}> {
  const headers = {
    'User-Agent': userAgent,
    Accept: REDDIT_ACCEPT_HEADER,
    'Accept-Language': REDDIT_ACCEPT_LANGUAGE_HEADER,
  };
  const primaryUrl = buildRedditSearchUrl(REDDIT_PRIMARY_ENDPOINT, query, pageLimit);

  try {
    const response = await axios.get<RedditSearchResponse>(primaryUrl, {
      headers,
      timeout: 15000,
    });
    const recentResultCount = response.data.data?.children?.length ?? 0;

    return {
      recentResultCount,
      pageLimitReached: recentResultCount === pageLimit,
      endpointTried: REDDIT_PRIMARY_ENDPOINT,
      alternateEndpointTried: null,
      statusCode: response.status,
      userAgentUsed: userAgent,
    };
  } catch (primaryError) {
    const primaryFailure = getAxiosFailureDebug(primaryError);

    if (primaryFailure.responseStatus !== 403) {
      throw new RedditSearchCountError({
        endpointTried: REDDIT_PRIMARY_ENDPOINT,
        alternateEndpointTried: null,
        statusCode: primaryFailure.responseStatus,
        userAgentUsed: userAgent,
        note: primaryFailure.note,
      });
    }

    const fallbackUrl = buildRedditSearchUrl(REDDIT_FALLBACK_ENDPOINT, query, pageLimit);

    try {
      const fallbackResponse = await axios.get<RedditSearchResponse>(fallbackUrl, {
        headers,
        timeout: 15000,
      });
      const recentResultCount = fallbackResponse.data.data?.children?.length ?? 0;

      return {
        recentResultCount,
        pageLimitReached: recentResultCount === pageLimit,
        endpointTried: REDDIT_PRIMARY_ENDPOINT,
        alternateEndpointTried: REDDIT_FALLBACK_ENDPOINT,
        statusCode: fallbackResponse.status,
        userAgentUsed: userAgent,
      };
    } catch (fallbackError) {
      const fallbackFailure = getAxiosFailureDebug(fallbackError);
      throw new RedditSearchCountError({
        endpointTried: REDDIT_PRIMARY_ENDPOINT,
        alternateEndpointTried: REDDIT_FALLBACK_ENDPOINT,
        statusCode: fallbackFailure.responseStatus,
        userAgentUsed: userAgent,
        note: `Primary endpoint failed (${primaryFailure.note}); alternate endpoint failed (${fallbackFailure.note}).`,
      });
    }
  }
}

async function fetchYouTubeVideoDetails(
  youtubeApiKey: string,
  candidateVideoIds: string[]
): Promise<NonNullable<YouTubeVideosResponse['items']>> {
  const detailItems: NonNullable<YouTubeVideosResponse['items']> = [];

  for (
    let start = 0;
    start < candidateVideoIds.length;
    start += YOUTUBE_VIDEOS_DETAILS_BATCH_SIZE
  ) {
    const batchIds = candidateVideoIds.slice(start, start + YOUTUBE_VIDEOS_DETAILS_BATCH_SIZE);
    if (batchIds.length === 0) {
      continue;
    }

    const detailsResponse = await axios.get<YouTubeVideosResponse>(
      'https://www.googleapis.com/youtube/v3/videos',
      {
        params: {
          key: youtubeApiKey,
          part: 'snippet,statistics',
          id: batchIds.join(','),
        },
        timeout: 15000,
      }
    );

    detailItems.push(...(detailsResponse.data.items ?? []));
  }

  return detailItems;
}

export async function getSocialValidationSignals(
  request: ValidationRunRequest
): Promise<SocialValidationSignals> {
  const socialQueryContext = getSocialQueryContextDebug(request);
  const socialDebugFields = {
    rawItemTitleInput: socialQueryContext.rawItemTitleInput,
    rawSocialQueryInput: socialQueryContext.rawSocialQueryInput,
    normalizedSocialQueryBase: socialQueryContext.normalizedSocialQueryBase,
    strippedVariationTerms: socialQueryContext.strippedVariationTerms,
    variationStripNote: socialQueryContext.variationStripNote,
  };
  const debug: SocialValidationDebugState = {
    twitter: { checked: false },
    youtube: { checked: false },
    reddit: { checked: false },
  };

  const result: SocialValidationSignals = {
    twitterTrending: null,
    youtubeViews24hMillions: null,
    redditPostsCount7d: null,
    debug,
  };

  const twitterToken = process.env.TWITTER_BEARER_TOKEN?.trim();
  const youtubeApiKey = process.env.YOUTUBE_API_KEY?.trim();
  const redditUserAgent = process.env.REDDIT_USER_AGENT?.trim() ?? DEFAULT_REDDIT_USER_AGENT;
  const skipTwitter = request.providerOptions?.skipTwitter === true;

  if (skipTwitter) {
    result.twitterTrending = false;
    debug.twitter = {
      checked: false,
      ...socialDebugFields,
      note: 'X/Twitter recent-count lookup skipped by providerOptions.skipTwitter.',
    };
  } else if (twitterToken) {
    const twitterQueryPlanResolution = normalizeResolvedQueryPlan(
      buildResolvedTwitterQueryPlanSafe(request)
    );
    const queryPlan = twitterQueryPlanResolution.queryPlan;
    const queryResolution = cloneQueryResolution(twitterQueryPlanResolution.queryResolution);
    const queryCandidates = getQueryCandidates(queryPlan);
    let selectedQuery = queryCandidates[0];
    let totalTweetCount: number | null = null;
    const queryDiagnostics: TwitterQueryDiagnostics = [];

    debug.twitter = {
      checked: true,
      ...socialDebugFields,
      queryCandidates,
      selectedQuery,
      query: selectedQuery,
      searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
      granularity: TWITTER_COUNTS_GRANULARITY,
      queryResolution: cloneQueryResolution(queryResolution),
    };

    for (const [index, query] of queryCandidates.entries()) {
      try {
        const response = await axios.get<TwitterRecentCountsResponse>(
          buildTwitterCountsUrl(query),
          {
            headers: { Authorization: `Bearer ${twitterToken}` },
            params: { query, granularity: TWITTER_COUNTS_GRANULARITY },
            timeout: 15000,
          }
        );

        const candidateTotal = response.data.meta?.total_tweet_count ?? 0;
        queryDiagnostics.push({
          query,
          family: getQueryPlanFamily(queryPlan, index),
          totalTweetCount: candidateTotal,
          responseStatus: 200,
        });
        if (totalTweetCount === null || candidateTotal > totalTweetCount) {
          totalTweetCount = candidateTotal;
          selectedQuery = query;
        }
      } catch (error) {
        const failure = getAxiosFailureDebug(error);
        queryDiagnostics.push({
          query,
          family: getQueryPlanFamily(queryPlan, index),
          totalTweetCount: null,
          responseStatus: failure.responseStatus,
          note: failure.note,
        });
      }
    }

    if (totalTweetCount !== null) {
      result.twitterTrending = (totalTweetCount ?? 0) >= TWITTER_TRENDING_THRESHOLD;
      debug.twitter = {
        checked: true,
        ...socialDebugFields,
        queryCandidates,
        selectedQuery,
        query: selectedQuery,
        searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
        totalTweetCount,
        granularity: TWITTER_COUNTS_GRANULARITY,
        queryDiagnostics,
        confidence: getConfidenceFromCount(totalTweetCount ?? 0),
        note: 'Recent X post count over the last 7 days used as a conversation-volume proxy.',
        queryResolution: cloneQueryResolution(queryResolution),
      };
    } else {
      debug.twitter = {
        checked: true,
        ...socialDebugFields,
        queryCandidates,
        selectedQuery,
        query: selectedQuery,
        searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
        totalTweetCount: null,
        granularity: TWITTER_COUNTS_GRANULARITY,
        queryDiagnostics,
        confidence: 'Low',
        note: 'All X recent-count query candidates failed or returned no usable count response.',
        queryResolution: cloneQueryResolution(queryResolution),
      };
    }
  }

  if (youtubeApiKey) {
    const primaryArtist = getPrimaryArtist(request);
    const albumPhrase =
      getPrimarySocialAlbumPhraseValue(request) || getPrimaryAlbumPhraseValue(request);
    const albumKeywords = extractSemanticTokenValues(albumPhrase);
    const youtubeQueryPlanResolution = normalizeResolvedQueryPlan(
      buildResolvedYouTubeQueryPlanSafe(request)
    );
    const queryPlan = youtubeQueryPlanResolution.queryPlan;
    const queryResolution = cloneQueryResolution(youtubeQueryPlanResolution.queryResolution);
    const queryCandidates = getQueryCandidates(queryPlan);
    const searchCandidateMap = new Map<string, YouTubeSearchCandidate>();
    const queryDiagnostics: YouTubeQueryDiagnostics = [];

    debug.youtube = {
      checked: true,
      ...socialDebugFields,
      queryCandidates,
      selectedQuery: queryCandidates[0],
      query: queryCandidates[0],
      searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
      resultsExamined: 0,
      queryResolution: cloneQueryResolution(queryResolution),
    };

    try {
      for (const [index, query] of queryCandidates.entries()) {
        const searchResponse = await axios.get<YouTubeSearchResponse>(
          buildYouTubeSearchUrl(query),
          {
            params: {
              key: youtubeApiKey,
              part: 'snippet',
              q: query,
              maxResults: YOUTUBE_SEARCH_MAX_RESULTS,
              order: 'viewCount',
              type: 'video',
            },
            timeout: 15000,
          }
        );

        const items = searchResponse.data.items ?? [];
        queryDiagnostics.push({
          query,
          family: getQueryPlanFamily(queryPlan, index),
          resultCount: items.length,
          topVideoTitles: items
            .slice(0, 3)
            .map((item) => item.snippet?.title ?? null)
            .filter((title): title is string => Boolean(title)),
        });

        for (const item of items) {
          const videoId = item.id?.videoId?.trim();
          if (!videoId) continue;

          const existing = searchCandidateMap.get(videoId);
          if (existing) {
            if (!existing.matchedQueries.includes(query)) {
              existing.matchedQueries.push(query);
            }
            continue;
          }

          if (searchCandidateMap.size >= YOUTUBE_MAX_CANDIDATE_VIDEOS) {
            continue;
          }

          searchCandidateMap.set(videoId, {
            videoId,
            title: item.snippet?.title ?? null,
            channelTitle: item.snippet?.channelTitle ?? null,
            matchedQueries: [query],
          });
        }
      }

      const candidateVideoIds = Array.from(searchCandidateMap.keys());
      if (candidateVideoIds.length > 0) {
        const detailItems = await fetchYouTubeVideoDetails(youtubeApiKey, candidateVideoIds);

        const rankedCandidates: RankedYouTubeCandidate[] = detailItems.map((item) => {
          const videoId = item.id?.trim() ?? '';
          const searchCandidate = searchCandidateMap.get(videoId);
          const publishedAt = item.snippet?.publishedAt ?? null;
          const totalViewsRaw = item.statistics?.viewCount;
          const totalViews = totalViewsRaw ? Number(totalViewsRaw) : null;
          const daysLive = getDaysLive(publishedAt);
          const avgDailyViews =
            totalViews !== null && daysLive !== null && daysLive > 0 ? totalViews / daysLive : null;

          return {
            videoId,
            title: item.snippet?.title ?? searchCandidate?.title ?? null,
            channelTitle: item.snippet?.channelTitle ?? searchCandidate?.channelTitle ?? null,
            matchedQueries: searchCandidate?.matchedQueries ?? [],
            totalViews,
            publishedAt,
            daysLive,
            avgDailyViews,
            relevanceScore: 0,
            rankingSignals: {
              candidateClass: 'fallback_adjacent',
              officialTitleSignal: false,
              officialChannelSignal: false,
              brandedChannelSignal: false,
              demotedTitleSignal: false,
              demotedChannelSignal: false,
              shortsPenalty: false,
              artistAlignment: false,
              albumPhraseAlignment: false,
              albumKeywordMatches: 0,
              queryMatchCount: searchCandidate?.matchedQueries.length ?? 0,
              officialReleaseScore: 0,
            },
          };
        });

        for (const candidate of rankedCandidates) {
          const ranking = scoreYouTubeCandidate(
            candidate,
            primaryArtist,
            albumPhrase,
            albumKeywords
          );
          candidate.relevanceScore = ranking.score;
          candidate.rankingSignals = {
            candidateClass: ranking.candidateClass,
            officialTitleSignal: ranking.officialTitleSignal,
            officialChannelSignal: ranking.officialChannelSignal,
            brandedChannelSignal: ranking.brandedChannelSignal,
            demotedTitleSignal: ranking.demotedTitleSignal,
            demotedChannelSignal: ranking.demotedChannelSignal,
            shortsPenalty: ranking.shortsPenalty,
            artistAlignment: ranking.artistAlignment,
            albumPhraseAlignment: ranking.albumPhraseAlignment,
            albumKeywordMatches: ranking.albumKeywordMatches,
            queryMatchCount: ranking.queryMatchCount,
            officialReleaseScore: ranking.officialReleaseScore,
          };
        }

        rankedCandidates.sort((left, right) => {
          const classDelta =
            getYouTubeCandidateClassRank(left.rankingSignals.candidateClass) -
            getYouTubeCandidateClassRank(right.rankingSignals.candidateClass);
          if (classDelta !== 0) {
            return classDelta;
          }
          if (right.relevanceScore !== left.relevanceScore) {
            return right.relevanceScore - left.relevanceScore;
          }
          return (right.totalViews ?? -1) - (left.totalViews ?? -1);
        });

        const selectedCandidate = rankedCandidates[0] ?? null;
        const selectedQuery = selectedCandidate?.matchedQueries[0] ?? queryCandidates[0];
        const selectedVideoUrl = selectedCandidate
          ? buildYouTubeVideoUrl(selectedCandidate.videoId)
          : null;
        const selectedAvgDailyViews =
          selectedCandidate?.avgDailyViews !== null &&
          selectedCandidate?.avgDailyViews !== undefined
            ? Math.round(selectedCandidate.avgDailyViews)
            : null;

        result.youtubeViews24hMillions = roundMillions(selectedCandidate?.avgDailyViews ?? null);
        debug.youtube = {
          checked: true,
          ...socialDebugFields,
          queryCandidates,
          selectedQuery,
          selectedCandidateClass: selectedCandidate?.rankingSignals.candidateClass ?? null,
          query: selectedQuery,
          searchUrl: selectedQuery ? buildYouTubeSearchUrl(selectedQuery) : undefined,
          resultsExamined: rankedCandidates.length,
          queryDiagnostics,
          selectedVideoId: selectedCandidate?.videoId ?? null,
          selectedVideoTitle: selectedCandidate?.title ?? null,
          selectedVideoUrl,
          selectedVideoViews: selectedCandidate?.totalViews ?? null,
          selectedVideoPublishedAt: selectedCandidate?.publishedAt ?? null,
          selectedVideoDaysLive: selectedCandidate?.daysLive ?? null,
          selectedVideoAvgDailyViews: selectedAvgDailyViews,
          candidateVideos: rankedCandidates.slice(0, 5).map((candidate) => ({
            videoId: candidate.videoId,
            title: candidate.title,
            url: buildYouTubeVideoUrl(candidate.videoId),
            channelTitle: candidate.channelTitle,
            totalViews: candidate.totalViews,
            publishedAt: candidate.publishedAt,
            avgDailyViews:
              candidate.avgDailyViews !== null ? Math.round(candidate.avgDailyViews) : null,
            relevanceScore: candidate.relevanceScore,
            matchedQueries: candidate.matchedQueries,
            candidateClass: candidate.rankingSignals.candidateClass,
            selectedByClass: candidate.videoId === selectedCandidate?.videoId,
            officialReleaseScore: candidate.rankingSignals.officialReleaseScore,
            officialTitleSignal: candidate.rankingSignals.officialTitleSignal,
            officialChannelSignal: candidate.rankingSignals.officialChannelSignal,
            brandedChannelSignal: candidate.rankingSignals.brandedChannelSignal,
            demotedTitleSignal: candidate.rankingSignals.demotedTitleSignal,
            demotedChannelSignal: candidate.rankingSignals.demotedChannelSignal,
            shortsPenalty: candidate.rankingSignals.shortsPenalty,
            artistAlignment: candidate.rankingSignals.artistAlignment,
            albumPhraseAlignment: candidate.rankingSignals.albumPhraseAlignment,
            albumKeywordMatches: candidate.rankingSignals.albumKeywordMatches,
            queryMatchCount: candidate.rankingSignals.queryMatchCount,
          })),
          topVideoTitle: selectedCandidate?.title ?? null,
          topVideoUrl: selectedVideoUrl,
          publishedAt: selectedCandidate?.publishedAt ?? null,
          totalViews: selectedCandidate?.totalViews ?? null,
          daysLive: selectedCandidate?.daysLive ?? null,
          avgDailyViews: selectedAvgDailyViews,
          confidence: getYouTubeConfidence(selectedCandidate?.avgDailyViews ?? null),
          note: 'Average daily views proxy selected from the best official/branded release candidate available, not true 24h delta.',
          queryResolution: cloneQueryResolution(queryResolution),
        };
      } else {
        debug.youtube = {
          checked: true,
          ...socialDebugFields,
          queryCandidates,
          selectedQuery: queryCandidates[0],
          selectedCandidateClass: null,
          query: queryCandidates[0],
          searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
          resultsExamined: 0,
          queryDiagnostics,
          selectedVideoId: null,
          selectedVideoTitle: null,
          selectedVideoUrl: null,
          selectedVideoViews: null,
          selectedVideoPublishedAt: null,
          selectedVideoDaysLive: null,
          selectedVideoAvgDailyViews: null,
          candidateVideos: [],
          topVideoTitle: null,
          topVideoUrl: null,
          publishedAt: null,
          totalViews: null,
          daysLive: null,
          avgDailyViews: null,
          confidence: 'Low',
          note: 'No suitable YouTube video candidates were returned for the current query set.',
          queryResolution: cloneQueryResolution(queryResolution),
        };
      }
    } catch (error) {
      debug.youtube = {
        checked: true,
        ...socialDebugFields,
        queryCandidates,
        selectedQuery: queryCandidates[0],
        selectedCandidateClass: null,
        query: queryCandidates[0],
        searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
        resultsExamined: 0,
        queryDiagnostics,
        selectedVideoId: null,
        selectedVideoTitle: null,
        selectedVideoUrl: null,
        selectedVideoViews: null,
        selectedVideoPublishedAt: null,
        selectedVideoDaysLive: null,
        selectedVideoAvgDailyViews: null,
        candidateVideos: [],
        topVideoTitle: null,
        topVideoUrl: null,
        publishedAt: null,
        totalViews: null,
        daysLive: null,
        avgDailyViews: null,
        confidence: 'Low',
        note: getErrorMessage(error),
        queryResolution: cloneQueryResolution(queryResolution),
      };
    }
  }

  {
    const redditQueryPlanResolution = normalizeResolvedQueryPlan(
      buildResolvedRedditQueryPlanSafe(request)
    );
    const queryPlan = redditQueryPlanResolution.queryPlan;
    const queryResolution = cloneQueryResolution(redditQueryPlanResolution.queryResolution);
    const queryCandidates = getQueryCandidates(queryPlan);
    const query = queryCandidates[0] ?? '';
    const pageLimit = REDDIT_PAGE_LIMIT;
    const queryDiagnostics: RedditQueryDiagnostics = [];
    let selectedQuery = query;
    let selectedSearchUrl = query
      ? buildRedditSearchUrl(REDDIT_PRIMARY_ENDPOINT, query, pageLimit)
      : undefined;
    let recentResultCount: number | null = null;
    let pageLimitReached: boolean | null = null;
    let endpointTried = query ? REDDIT_PRIMARY_ENDPOINT : undefined;
    let alternateEndpointTried: string | null = null;
    let statusCode: number | null = null;

    debug.reddit = {
      checked: true,
      ...socialDebugFields,
      query,
      queryCandidates,
      selectedQuery,
      searchUrl: selectedSearchUrl,
      pageLimit,
      endpointTried,
      alternateEndpointTried,
      statusCode,
      userAgentUsed: redditUserAgent,
      queryResolution: cloneQueryResolution(queryResolution),
    };

    for (const [index, candidate] of queryCandidates.entries()) {
      const searchUrl = buildRedditSearchUrl(REDDIT_PRIMARY_ENDPOINT, candidate, pageLimit);
      try {
        const response = await fetchRedditSearchCount(candidate, pageLimit, redditUserAgent);
        const candidateCount = response.recentResultCount;
        const candidateLimitReached = response.pageLimitReached;
        queryDiagnostics.push({
          query: candidate,
          family: getQueryPlanFamily(queryPlan, index),
          recentResultCount: candidateCount,
          pageLimitReached: candidateLimitReached,
          endpointTried: response.endpointTried,
          alternateEndpointTried: response.alternateEndpointTried,
          statusCode: response.statusCode,
          userAgentUsed: response.userAgentUsed,
        });

        if (recentResultCount === null || candidateCount > recentResultCount) {
          recentResultCount = candidateCount;
          pageLimitReached = candidateLimitReached;
          selectedQuery = candidate;
          selectedSearchUrl =
            response.alternateEndpointTried !== null
              ? buildRedditSearchUrl(response.alternateEndpointTried, candidate, pageLimit)
              : searchUrl;
          endpointTried = response.endpointTried;
          alternateEndpointTried = response.alternateEndpointTried;
          statusCode = response.statusCode;
        }
      } catch (error) {
        const failure =
          error instanceof RedditSearchCountError
            ? {
                endpointTried: error.endpointTried,
                alternateEndpointTried: error.alternateEndpointTried,
                statusCode: error.statusCode,
                userAgentUsed: error.userAgentUsed,
                note: error.message,
              }
            : {
                endpointTried: REDDIT_PRIMARY_ENDPOINT,
                alternateEndpointTried: null,
                statusCode: getAxiosFailureDebug(error).responseStatus,
                userAgentUsed: redditUserAgent,
                note: getAxiosFailureDebug(error).note,
              };
        queryDiagnostics.push({
          query: candidate,
          family: getQueryPlanFamily(queryPlan, index),
          recentResultCount: null,
          pageLimitReached: null,
          endpointTried: failure.endpointTried,
          alternateEndpointTried: failure.alternateEndpointTried ?? null,
          statusCode: failure.statusCode ?? null,
          userAgentUsed: failure.userAgentUsed ?? redditUserAgent,
          note: failure.note,
        });

        if (recentResultCount === null) {
          selectedQuery = candidate;
          const failedAlternateEndpoint = failure.alternateEndpointTried;
          selectedSearchUrl =
            typeof failedAlternateEndpoint === 'string'
              ? buildRedditSearchUrl(failedAlternateEndpoint, candidate, pageLimit)
              : searchUrl;
          endpointTried = failure.endpointTried;
          alternateEndpointTried = failedAlternateEndpoint ?? null;
          statusCode = failure.statusCode ?? null;
        }
      }
    }

    if (recentResultCount !== null) {
      result.redditPostsCount7d = recentResultCount;
      debug.reddit = {
        checked: true,
        ...socialDebugFields,
        query: selectedQuery,
        queryCandidates,
        selectedQuery,
        searchUrl: selectedSearchUrl,
        queryDiagnostics,
        recentResultCount,
        pageLimit,
        pageLimitReached,
        endpointTried,
        alternateEndpointTried,
        statusCode,
        userAgentUsed: redditUserAgent,
        confidence: getConfidenceFromCount(recentResultCount),
        note: 'Recent Reddit post sample count from the first page of weekly results, not total weekly discussion volume.',
        queryResolution: cloneQueryResolution(queryResolution),
      };
    } else {
      debug.reddit = {
        checked: true,
        ...socialDebugFields,
        query: selectedQuery,
        queryCandidates,
        selectedQuery,
        searchUrl: selectedSearchUrl,
        queryDiagnostics,
        recentResultCount: null,
        pageLimit,
        pageLimitReached: null,
        endpointTried,
        alternateEndpointTried,
        statusCode,
        userAgentUsed: redditUserAgent,
        confidence: 'Low',
        note: 'All Reddit discussion-oriented query candidates failed before a usable sample count was returned.',
        queryResolution: cloneQueryResolution(queryResolution),
      };
    }
  }

  return result;
}
