import axios from 'axios';
import type {
  SocialValidationSignals,
  ValidationRunRequest,
  ValidationSignalConfidence,
} from '../types.js';
import { buildValidationQueryCandidates, normalizeWhitespace } from './query-utils.js';

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
}

const REDDIT_PAGE_LIMIT = 100;
const YOUTUBE_SEARCH_MAX_RESULTS = 5;
const YOUTUBE_MAX_CANDIDATE_VIDEOS = 15;
const TWITTER_COUNTS_GRANULARITY = 'day' as const;
const TWITTER_TRENDING_THRESHOLD = 10;

function getPrimaryArtist(request: ValidationRunRequest): string {
  return request.item.canonicalArtists[0]?.trim() ?? '';
}

function getPrimaryAlbum(request: ValidationRunRequest): string {
  return request.item.relatedAlbums[0]?.trim() ?? normalizeWhitespace(request.item.name);
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean)));
}

function tokenizeKeywords(value: string): string[] {
  return Array.from(
    new Set(
      normalizeWhitespace(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 2)
    )
  );
}

function buildTwitterQueryCandidates(request: ValidationRunRequest): string[] {
  const primaryArtist = getPrimaryArtist(request);
  const primaryAlbum = getPrimaryAlbum(request);
  const browseCandidates = buildValidationQueryCandidates(request);

  return dedupeStrings([
    `${primaryArtist} ${primaryAlbum}`,
    browseCandidates[0] ?? '',
    browseCandidates[1] ?? '',
    primaryArtist,
  ]);
}

function buildYouTubeQueryCandidates(request: ValidationRunRequest): string[] {
  const primaryArtist = getPrimaryArtist(request);
  const primaryAlbum = getPrimaryAlbum(request);
  const releaseTitle = normalizeWhitespace(request.item.name);
  const browseCandidates = buildValidationQueryCandidates(request);

  return dedupeStrings([
    `${primaryArtist} ${primaryAlbum}`,
    `${primaryArtist} ${primaryAlbum} official`,
    `${primaryArtist} ${primaryAlbum} mv`,
    `${primaryArtist} ${primaryAlbum} music video`,
    `${primaryArtist} ${primaryAlbum} teaser`,
    browseCandidates[0] ?? '',
    browseCandidates[1] ?? '',
    `${primaryArtist} ${releaseTitle}`,
  ]);
}

function buildRedditQuery(request: ValidationRunRequest): string {
  return normalizeWhitespace(`${getPrimaryArtist(request)} ${getPrimaryAlbum(request)}`);
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
  albumKeywords: string[]
): number {
  const title = normalizeWhitespace(candidate.title ?? '').toLowerCase();
  const channelTitle = normalizeWhitespace(candidate.channelTitle ?? '').toLowerCase();
  const combinedText = `${title} ${channelTitle}`;
  const normalizedArtist = normalizeWhitespace(primaryArtist).toLowerCase();
  const albumMatches = albumKeywords.filter((keyword) => combinedText.includes(keyword)).length;
  const hasOfficialSignal = /\bofficial\b|\bmv\b|music video|teaser|performance/.test(title);
  const hasOfficialChannelSignal = /\bofficial\b|\btopic\b/.test(channelTitle);
  const viewSignal =
    candidate.totalViews !== null ? Math.min(10, Math.log10(candidate.totalViews + 1)) : 0;

  return (
    (normalizedArtist.length > 0 && combinedText.includes(normalizedArtist) ? 100 : 0) +
    albumMatches * 20 +
    (hasOfficialSignal ? 5 : 0) +
    (hasOfficialChannelSignal ? 3 : 0) +
    viewSignal
  );
}

export async function getSocialValidationSignals(
  request: ValidationRunRequest
): Promise<SocialValidationSignals> {
  const result: SocialValidationSignals = {
    twitterTrending: null,
    youtubeViews24hMillions: null,
    redditPostsCount7d: null,
    debug: {
      twitter: { checked: false },
      youtube: { checked: false },
      reddit: { checked: false },
    },
  };

  const twitterToken = process.env.TWITTER_BEARER_TOKEN?.trim();
  const youtubeApiKey = process.env.YOUTUBE_API_KEY?.trim();
  const redditUserAgent = process.env.REDDIT_USER_AGENT?.trim() ?? 'ebay-mcp-validation/1.0';

  if (twitterToken) {
    const queryCandidates = buildTwitterQueryCandidates(request);
    let selectedQuery = queryCandidates[0];
    let totalTweetCount: number | null = null;

    result.debug!.twitter = {
      checked: true,
      queryCandidates,
      selectedQuery,
      query: selectedQuery,
      searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
      granularity: TWITTER_COUNTS_GRANULARITY,
    };

    try {
      for (const query of queryCandidates) {
        const response = await axios.get<TwitterRecentCountsResponse>(
          buildTwitterCountsUrl(query),
          {
            headers: { Authorization: `Bearer ${twitterToken}` },
            params: { query, granularity: TWITTER_COUNTS_GRANULARITY },
            timeout: 15000,
          }
        );

        const candidateTotal = response.data.meta?.total_tweet_count ?? 0;
        if (totalTweetCount === null || candidateTotal > totalTweetCount) {
          totalTweetCount = candidateTotal;
          selectedQuery = query;
        }
      }

      result.twitterTrending = (totalTweetCount ?? 0) >= TWITTER_TRENDING_THRESHOLD;
      result.debug!.twitter = {
        checked: true,
        queryCandidates,
        selectedQuery,
        query: selectedQuery,
        searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
        totalTweetCount,
        granularity: TWITTER_COUNTS_GRANULARITY,
        confidence: getConfidenceFromCount(totalTweetCount ?? 0),
        note: 'Recent X post count over the last 7 days used as a conversation-volume proxy.',
      };
    } catch (error) {
      result.debug!.twitter = {
        checked: true,
        queryCandidates,
        selectedQuery,
        query: selectedQuery,
        searchUrl: selectedQuery ? buildTwitterCountsUrl(selectedQuery) : undefined,
        totalTweetCount: null,
        granularity: TWITTER_COUNTS_GRANULARITY,
        confidence: 'Low',
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (youtubeApiKey) {
    const primaryArtist = getPrimaryArtist(request);
    const albumKeywords = tokenizeKeywords(getPrimaryAlbum(request));
    const queryCandidates = buildYouTubeQueryCandidates(request);
    const searchCandidateMap = new Map<string, YouTubeSearchCandidate>();

    result.debug!.youtube = {
      checked: true,
      queryCandidates,
      selectedQuery: queryCandidates[0],
      query: queryCandidates[0],
      searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
      resultsExamined: 0,
    };

    try {
      for (const query of queryCandidates) {
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

        for (const item of searchResponse.data.items ?? []) {
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
            };
          }
        );

        for (const candidate of rankedCandidates) {
          candidate.relevanceScore = scoreYouTubeCandidate(candidate, primaryArtist, albumKeywords);
        }

        rankedCandidates.sort((left, right) => {
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
        result.debug!.youtube = {
          checked: true,
          queryCandidates,
          selectedQuery,
          query: selectedQuery,
          searchUrl: selectedQuery ? buildYouTubeSearchUrl(selectedQuery) : undefined,
          resultsExamined: rankedCandidates.length,
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
          })),
          topVideoTitle: selectedCandidate?.title ?? null,
          topVideoUrl: selectedVideoUrl,
          publishedAt: selectedCandidate?.publishedAt ?? null,
          totalViews: selectedCandidate?.totalViews ?? null,
          daysLive: selectedCandidate?.daysLive ?? null,
          avgDailyViews: selectedAvgDailyViews,
          confidence: getYouTubeConfidence(selectedCandidate?.avgDailyViews ?? null),
          note: 'Average daily views proxy selected from the best relevant high-view candidate, not true 24h delta.',
        };
      } else {
        result.debug!.youtube = {
          checked: true,
          queryCandidates,
          selectedQuery: queryCandidates[0],
          query: queryCandidates[0],
          searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
          resultsExamined: 0,
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
      result.debug!.youtube = {
        checked: true,
        queryCandidates,
        selectedQuery: queryCandidates[0],
        query: queryCandidates[0],
        searchUrl: queryCandidates[0] ? buildYouTubeSearchUrl(queryCandidates[0]) : undefined,
        resultsExamined: 0,
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
    const query = buildRedditQuery(request);
    const pageLimit = REDDIT_PAGE_LIMIT;
    const searchUrl = buildRedditSearchUrl(query, pageLimit);
    result.debug!.reddit = { checked: true, query, searchUrl, pageLimit };

    try {
      const response = await axios.get<RedditSearchResponse>(searchUrl, {
        headers: { 'User-Agent': redditUserAgent },
        params: { limit: pageLimit },
        timeout: 15000,
      });
      const recentResultCount = response.data.data?.children?.length ?? 0;
      const pageLimitReached = recentResultCount === pageLimit;
      result.redditPostsCount7d = recentResultCount;
      result.debug!.reddit = {
        checked: true,
        query,
        searchUrl,
        recentResultCount,
        pageLimit,
        pageLimitReached,
        confidence: getConfidenceFromCount(recentResultCount),
        note: 'Recent Reddit post sample count from the first page of weekly results, not total weekly discussion volume.',
      };
    } catch (error) {
      result.debug!.reddit = {
        checked: true,
        query,
        searchUrl,
        recentResultCount: null,
        pageLimit,
        pageLimitReached: null,
        confidence: 'Low',
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return result;
}
