import process from 'node:process';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSocialValidationSignals } from '../../../src/validation/providers/social.js';
import type { ValidationRunRequest } from '../../../src/validation/types.js';

vi.mock('axios');

const axiosGetMock = vi.mocked(axios.get);

function createRequest(overrides: Partial<ValidationRunRequest> = {}): ValidationRunRequest {
  return {
    validationId: 'val_123',
    runType: 'scheduled',
    cadence: 'Daily',
    timestamp: '2026-04-06T00:00:00.000Z',
    item: {
      recordId: 'rec_123',
      name: 'BTS ARIRANG Limited Album',
      variation: ['Limited'],
      itemType: ['Album'],
      releaseType: ['Album'],
      releaseDate: null,
      releasePeriod: [],
      availability: ['In Stock'],
      wholesalePrice: null,
      supplierNames: [],
      canonicalArtists: ['BTS'],
      relatedAlbums: ['ARIRANG'],
    },
    validation: {
      validationType: 'Album Validation',
      buyDecision: 'Hold',
      automationStatus: 'Manual',
      autoCheckEnabled: false,
      dDay: null,
      artistTier: 'A',
      initialBudget: null,
      reserveBudget: null,
      queryContext: {
        directQueryActive: false,
        queryScope: 'Artist + Album',
      },
      currentMetrics: {
        avgWatchersPerListing: null,
        preOrderListingsCount: null,
        twitterTrending: false,
        youtubeViews24hMillions: null,
        redditPostsCount7d: null,
        marketPriceUsd: null,
        avgShippingCostUsd: null,
        competitionLevel: null,
        marketPriceTrend: 'Stable',
        day1Sold: null,
        day2Sold: null,
        day3Sold: null,
        day4Sold: null,
        day5Sold: null,
        daysTracked: null,
      },
    },
    ...overrides,
  };
}

describe('getSocialValidationSignals()', () => {
  const originalTwitterToken = process.env.TWITTER_BEARER_TOKEN;
  const originalYoutubeApiKey = process.env.YOUTUBE_API_KEY;

  beforeEach(() => {
    process.env.TWITTER_BEARER_TOKEN = 'test-twitter-token';
    delete process.env.YOUTUBE_API_KEY;
    axiosGetMock.mockReset();
    axiosGetMock.mockImplementation(async (url: string) => {
      if (url.includes('api.twitter.com') || url.includes('api.x.com')) {
        throw new Error(`unexpected Twitter/X request: ${url}`);
      }
      return {
        status: 200,
        data: {
          data: {
            children: [],
          },
        },
      };
    });
  });

  afterEach(() => {
    if (originalTwitterToken === undefined) delete process.env.TWITTER_BEARER_TOKEN;
    else process.env.TWITTER_BEARER_TOKEN = originalTwitterToken;

    if (originalYoutubeApiKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = originalYoutubeApiKey;
  });

  it('skips Twitter/X API calls when providerOptions.skipTwitter is true', async () => {
    const result = await getSocialValidationSignals(
      createRequest({ providerOptions: { skipTwitter: true } })
    );

    expect(result.twitterTrending).toBe(false);
    expect(result.debug?.twitter?.checked).toBe(false);
    expect(result.debug?.twitter?.note).toContain('providerOptions.skipTwitter');
    expect(axiosGetMock).not.toHaveBeenCalledWith(
      expect.stringContaining('api.twitter.com'),
      expect.anything()
    );
  });
});
