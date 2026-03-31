import axios from 'axios';
import type {
  SocialValidationSignals,
  ValidationRunRequest,
  ValidationSignalConfidence,
} from '../types.js';
import { buildValidationQueryCandidates, normalizeWhitespace } from './query-utils.js';

interface TwitterRecentSearchResponse {
  meta?: {
    result_count?: number;
  };
}

interface YouTubeSearchResponse {
  items?: {
    id?: { videoId?: string };
    snippet?: { title?: string };
  }[];
}

interface YouTubeVideosResponse {
  items?: {
    snippet?: { title?: string; publishedAt?: string };
    statistics?: { viewCount?: string };
  }[];
}

interface RedditSearchResponse {
  data?: {
    children?: unknown[];
  };
}

function getPrimaryArtist(request: ValidationRunRequest): string {
  return request.item.canonicalArtists[0]?.trim() ?? '';
}

function getPrimaryAlbum(request: ValidationRunRequest): string {
  return request.item.relatedAlbums[0]?.trim() ?? normalizeWhitespace(request.item.name);
}

function buildTwitterQuery(request: ValidationRunRequest): string {
  return normalizeWhitespace(`${getPrimaryArtist(request)} ${getPrimaryAlbum(request)}`);
}

function buildYouTubeQuery(request: ValidationRunRequest): string {
  const candidate = buildValidationQueryCandidates(request)[0] ?? request.item.name;
  return normalizeWhitespace(candidate);
}

function buildRedditQuery(request: ValidationRunRequest): string {
  return normalizeWhitespace(`${getPrimaryArtist(request)} ${getPrimaryAlbum(request)}`);
}

function buildTwitterSearchUrl(query: string): string {
  return `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}`;
}

function buildYouTubeSearchUrl(query: string): string {
  return `https://www.googleapis.com/youtube/v3/search?q=${encodeURIComponent(query)}`;
}

function buildRedditSearchUrl(query: string): string {
  return `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week`;
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
    const query = buildTwitterQuery(request);
    const searchUrl = buildTwitterSearchUrl(query);
    result.debug!.twitter = { checked: true, query, searchUrl };

    try {
      const response = await axios.get<TwitterRecentSearchResponse>(searchUrl, {
        headers: { Authorization: `Bearer ${twitterToken}` },
        params: { max_results: 25 },
        timeout: 15000,
      });
      const recentResultCount = response.data.meta?.result_count ?? 0;
      result.twitterTrending = recentResultCount >= 10;
      result.debug!.twitter = {
        checked: true,
        query,
        searchUrl,
        recentResultCount,
        confidence: getConfidenceFromCount(recentResultCount),
        note: 'Recent Twitter/X search result count used as a phase-1 activity proxy.',
      };
    } catch (error) {
      result.debug!.twitter = {
        checked: true,
        query,
        searchUrl,
        recentResultCount: null,
        confidence: 'Low',
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (youtubeApiKey) {
    const query = buildYouTubeQuery(request);
    const searchUrl = buildYouTubeSearchUrl(query);
    result.debug!.youtube = { checked: true, query, searchUrl };

    try {
      const searchResponse = await axios.get<YouTubeSearchResponse>(searchUrl, {
        params: {
          key: youtubeApiKey,
          part: 'snippet',
          q: query,
          maxResults: 1,
          type: 'video',
        },
        timeout: 15000,
      });

      const topVideo = searchResponse.data.items?.[0];
      const videoId = topVideo?.id?.videoId;
      if (videoId) {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const detailsResponse = await axios.get<YouTubeVideosResponse>(
          'https://www.googleapis.com/youtube/v3/videos',
          {
            params: {
              key: youtubeApiKey,
              part: 'snippet,statistics',
              id: videoId,
            },
            timeout: 15000,
          }
        );

        const video = detailsResponse.data.items?.[0];
        const publishedAt = video?.snippet?.publishedAt ?? null;
        const totalViewsRaw = video?.statistics?.viewCount;
        const totalViews = totalViewsRaw ? Number(totalViewsRaw) : null;
        const publishedDate = publishedAt ? new Date(publishedAt) : null;
        const daysLive =
          publishedDate && Number.isFinite(publishedDate.getTime())
            ? Math.max(
                1,
                Math.floor((Date.now() - publishedDate.getTime()) / (24 * 60 * 60 * 1000))
              )
            : null;
        const avgDailyViews =
          totalViews !== null && daysLive !== null && daysLive > 0 ? totalViews / daysLive : null;

        result.youtubeViews24hMillions =
          avgDailyViews !== null ? Math.round((avgDailyViews / 1_000_000) * 1000) / 1000 : null;
        result.debug!.youtube = {
          checked: true,
          query,
          searchUrl,
          topVideoTitle: video?.snippet?.title ?? topVideo?.snippet?.title ?? null,
          topVideoUrl: videoUrl,
          publishedAt,
          totalViews,
          daysLive,
          avgDailyViews: avgDailyViews !== null ? Math.round(avgDailyViews) : null,
          confidence: getYouTubeConfidence(avgDailyViews),
          note: 'Average daily views proxy, not true 24h delta.',
        };
      } else {
        result.debug!.youtube = {
          checked: true,
          query,
          searchUrl,
          topVideoTitle: null,
          topVideoUrl: null,
          publishedAt: null,
          totalViews: null,
          daysLive: null,
          avgDailyViews: null,
          confidence: 'Low',
          note: 'No suitable YouTube video result found for the current query.',
        };
      }
    } catch (error) {
      result.debug!.youtube = {
        checked: true,
        query,
        searchUrl,
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
    const searchUrl = buildRedditSearchUrl(query);
    result.debug!.reddit = { checked: true, query, searchUrl };

    try {
      const response = await axios.get<RedditSearchResponse>(searchUrl, {
        headers: { 'User-Agent': redditUserAgent },
        timeout: 15000,
      });
      const recentResultCount = response.data.data?.children?.length ?? 0;
      result.redditPostsCount7d = recentResultCount;
      result.debug!.reddit = {
        checked: true,
        query,
        searchUrl,
        recentResultCount,
        confidence: getConfidenceFromCount(recentResultCount),
        note: 'Recent Reddit post count over the last week used as a phase-1 discussion proxy.',
      };
    } catch (error) {
      result.debug!.reddit = {
        checked: true,
        query,
        searchUrl,
        recentResultCount: null,
        confidence: 'Low',
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return result;
}
