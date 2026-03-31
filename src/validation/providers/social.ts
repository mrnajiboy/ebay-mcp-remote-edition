import axios from 'axios';
import type {
  SocialValidationSignals,
  ValidationRunRequest,
  ValidationSignalConfidence,
  YouTubeCandidateClass,
} from '../types.js';
import {
  buildRedditQueryPlan,
  buildTwitterQueryPlan,
  buildYouTubeQueryPlan,
  extractSemanticTokens,
  getPrimaryAlbumPhrase,
  normalizeWhitespace,
} from './query-utils.js';

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

interface SocialValidationDebugState {
  twitter: NonNullable<NonNullable<SocialValidationSignals['debug']>['twitter']>;
  youtube: NonNullable<NonNullable<SocialValidationSignals['debug']>['youtube']>;
  reddit: NonNullable<NonNullable<SocialValidationSignals['debug']>['reddit']>;
}

const REDDIT_PAGE_LIMIT = 100;
const YOUTUBE_SEARCH_MAX_RESULTS = 5;
const YOUTUBE_MAX_CANDIDATE_VIDEOS = 15;
const TWITTER_COUNTS_GRANULARITY = 'day' as const;
const TWITTER_TRENDING_THRESHOLD = 10;
const YOUTUBE_OFFICIAL_TITLE_PATTERN =
  /\bofficial\b|\bmv\b|music video|teaser|concept|highlight medley|performance|special video/;
const YOUTUBE_DEMOTED_TITLE_PATTERN =
  /unboxing|shop\b|store\b|merch|haul|reaction|cover|fan cam|fancam|reseller|resale/;
const YOUTUBE_SHORTS_PATTERN = /shorts?\b/;
const YOUTUBE_OFFICIAL_CHANNEL_PATTERN = /\bofficial\b|\btopic\b/;
const YOUTUBE_BRANDED_CHANNEL_PATTERN = /entertainment|music|records|labels?/;

function getPrimaryArtist(request: ValidationRunRequest): string {
  return request.item.canonicalArtists[0]?.trim() ?? '';
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

function buildRedditSearchUrl(query: string, pageLimit: number): string {
  return `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=${pageLimit}`;
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
  const normalizedAlbumPhrase = normalizeWhitespace(albumPhrase).toLowerCase();
  const albumMatches = albumKeywords.filter((keyword) => combinedText.includes(keyword)).length;
  const hasOfficialSignal = YOUTUBE_OFFICIAL_TITLE_PATTERN.test(title);
  const hasOfficialChannelSignal = YOUTUBE_OFFICIAL_CHANNEL_PATTERN.test(channelTitle);
  const hasBrandedChannelSignal = YOUTUBE_BRANDED_CHANNEL_PATTERN.test(channelTitle);
  const hasDemotedTitleSignal = YOUTUBE_DEMOTED_TITLE_PATTERN.test(title);
  const hasShortsSignal = YOUTUBE_SHORTS_PATTERN.test(title);
  const hasDemotedChannelSignal = /shop\b|store\b|merch|reseller|resale|unboxing/.test(
    channelTitle
  );
  const channelContainsArtist =
    normalizedArtist.length > 0 && channelTitle.includes(normalizedArtist);
  const hasAlbumPhraseMatch =
    normalizedAlbumPhrase.length > 0 && combinedText.includes(normalizedAlbumPhrase);
  const hasArtistAlignment = normalizedArtist.length > 0 && combinedText.includes(normalizedArtist);
  const queryMatchBoost = candidate.matchedQueries.length * 8;
  const viewSignal =
    candidate.totalViews !== null ? Math.min(8, Math.log10(candidate.totalViews + 1)) : 0;
  const officialReleaseScore =
    (hasOfficialSignal ? 90 : 0) +
    (hasOfficialChannelSignal ? 95 : 0) +
    (hasBrandedChannelSignal && channelContainsArtist ? 35 : 0) +
    (hasAlbumPhraseMatch ? 20 : 0) +
    albumMatches * 12 -
    (hasDemotedTitleSignal ? 120 : 0) -
    (hasShortsSignal ? 70 : 0) -
    (hasDemotedChannelSignal ? 90 : 0);
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
    (candidateClass === 'official_release' ? 160 : candidateClass === 'branded_media' ? 70 : 0) +
    (hasArtistAlignment ? 95 : 0) +
    (hasAlbumPhraseMatch ? 40 : 0) +
    albumMatches * 18 +
    queryMatchBoost +
    viewSignal;

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

function getAxiosFailureDebug(error: unknown): {
  responseStatus: number | null;
  note: string;
} {
  if (!axios.isAxiosError(error)) {
    return {
      responseStatus: null,
      note: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    responseStatus: error.response?.status ?? null,
    note: error.message,
  };
}

export async function getSocialValidationSignals(
  request: ValidationRunRequest
): Promise<SocialValidationSignals> {
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
  const redditUserAgent = process.env.REDDIT_USER_AGENT?.trim() ?? 'ebay-mcp-validation/1.0';

  if (twitterToken) {
    const queryPlan = buildTwitterQueryPlan(request);
    const queryCandidates = queryPlan.map((candidate) => candidate.query);
    let selectedQuery = queryCandidates[0];
    let totalTweetCount: number | null = null;
    const queryDiagnostics: NonNullable<
      NonNullable<NonNullable<SocialValidationSignals['debug']>['twitter']>['queryDiagnostics']
    > = [];

    debug.twitter = {
      checked: true,
      queryCandidates,
      selectedQuery,
      query: selectedQuery,
      searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
      granularity: TWITTER_COUNTS_GRANULARITY,
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
          family: queryPlan[index]?.family,
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
          family: queryPlan[index]?.family,
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
        queryCandidates,
        selectedQuery,
        query: selectedQuery,
        searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
        totalTweetCount,
        granularity: TWITTER_COUNTS_GRANULARITY,
        queryDiagnostics,
        confidence: getConfidenceFromCount(totalTweetCount ?? 0),
        note: 'Recent X post count over the last 7 days used as a conversation-volume proxy.',
      };
    } else {
      debug.twitter = {
        checked: true,
        queryCandidates,
        selectedQuery,
        query: selectedQuery,
        searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
        totalTweetCount: null,
        granularity: TWITTER_COUNTS_GRANULARITY,
        queryDiagnostics,
        confidence: 'Low',
        note: 'All X recent-count query candidates failed or returned no usable count response.',
      };
    }
  }

  if (youtubeApiKey) {
    const primaryArtist = getPrimaryArtist(request);
    const albumPhrase = getPrimaryAlbumPhrase(request);
    const albumKeywords = extractSemanticTokens(albumPhrase);
    const queryPlan = buildYouTubeQueryPlan(request);
    const queryCandidates = queryPlan.map((candidate) => candidate.query);
    const searchCandidateMap = new Map<string, YouTubeSearchCandidate>();
    const queryDiagnostics: NonNullable<
      NonNullable<NonNullable<SocialValidationSignals['debug']>['youtube']>['queryDiagnostics']
    > = [];

    debug.youtube = {
      checked: true,
      queryCandidates,
      selectedQuery: queryCandidates[0],
      query: queryCandidates[0],
      searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
      resultsExamined: 0,
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
          family: queryPlan[index]?.family,
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
        const detailsResponse = await axios.get<YouTubeVideosResponse>(
          'https://www.googleapis.com/youtube/v3/videos',
          {
            params: {
              key: youtubeApiKey,
              part: 'snippet,statistics',
              id: candidateVideoIds.join(','),
            },
            timeout: 15000,
          }
        );

        const rankedCandidates: RankedYouTubeCandidate[] = (detailsResponse.data.items ?? []).map(
          (item) => {
            const videoId = item.id?.trim() ?? '';
            const searchCandidate = searchCandidateMap.get(videoId);
            const publishedAt = item.snippet?.publishedAt ?? null;
            const totalViewsRaw = item.statistics?.viewCount;
            const totalViews = totalViewsRaw ? Number(totalViewsRaw) : null;
            const daysLive = getDaysLive(publishedAt);
            const avgDailyViews =
              totalViews !== null && daysLive !== null && daysLive > 0
                ? totalViews / daysLive
                : null;

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
          }
        );

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
        };
      } else {
        debug.youtube = {
          checked: true,
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
        };
      }
    } catch (error) {
      debug.youtube = {
        checked: true,
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
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }

  {
    const queryPlan = buildRedditQueryPlan(request);
    const queryCandidates = queryPlan.map((candidate) => candidate.query);
    const query = queryCandidates[0] ?? '';
    const pageLimit = REDDIT_PAGE_LIMIT;
    const queryDiagnostics: NonNullable<
      NonNullable<NonNullable<SocialValidationSignals['debug']>['reddit']>['queryDiagnostics']
    > = [];
    let selectedQuery = query;
    let selectedSearchUrl = query ? buildRedditSearchUrl(query, pageLimit) : undefined;
    let recentResultCount: number | null = null;
    let pageLimitReached: boolean | null = null;

    debug.reddit = {
      checked: true,
      query,
      queryCandidates,
      selectedQuery,
      searchUrl: selectedSearchUrl,
      pageLimit,
    };

    for (const [index, candidate] of queryCandidates.entries()) {
      const searchUrl = buildRedditSearchUrl(candidate, pageLimit);
      try {
        const response = await axios.get<RedditSearchResponse>(searchUrl, {
          headers: { 'User-Agent': redditUserAgent },
          params: { limit: pageLimit },
          timeout: 15000,
        });
        const candidateCount = response.data.data?.children?.length ?? 0;
        const candidateLimitReached = candidateCount === pageLimit;
        queryDiagnostics.push({
          query: candidate,
          family: queryPlan[index]?.family,
          recentResultCount: candidateCount,
          pageLimitReached: candidateLimitReached,
        });

        if (recentResultCount === null || candidateCount > recentResultCount) {
          recentResultCount = candidateCount;
          pageLimitReached = candidateLimitReached;
          selectedQuery = candidate;
          selectedSearchUrl = searchUrl;
        }
      } catch (error) {
        const failure = getAxiosFailureDebug(error);
        queryDiagnostics.push({
          query: candidate,
          family: queryPlan[index]?.family,
          recentResultCount: null,
          pageLimitReached: null,
          note: failure.note,
        });
      }
    }

    if (recentResultCount !== null) {
      result.redditPostsCount7d = recentResultCount;
      debug.reddit = {
        checked: true,
        query: selectedQuery,
        queryCandidates,
        selectedQuery,
        searchUrl: selectedSearchUrl,
        queryDiagnostics,
        recentResultCount,
        pageLimit,
        pageLimitReached,
        confidence: getConfidenceFromCount(recentResultCount),
        note: 'Recent Reddit post sample count from the first page of weekly results, not total weekly discussion volume.',
      };
    } else {
      debug.reddit = {
        checked: true,
        query: selectedQuery,
        queryCandidates,
        selectedQuery,
        searchUrl: selectedSearchUrl,
        queryDiagnostics,
        recentResultCount: null,
        pageLimit,
        pageLimitReached: null,
        confidence: 'Low',
        note: 'All Reddit discussion-oriented query candidates failed before a usable sample count was returned.',
      };
    }
  }

  return result;
}
