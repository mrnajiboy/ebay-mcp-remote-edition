import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { MediaApi } from '@/api/media/media.js';
import type { EbayApiClient } from '@/api/client.js';

vi.mock('axios');

const thumbnailUrl = 'https://i.ebayimg.com/00/s/ODBYODA=/z/example/$_1.JPG?set_id=8800005007';
const fullSizeUrl = 'https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/example/$_1.JPG?set_id=8800005007';

function makeClient(hasUserTokens = true): EbayApiClient {
  return {
    getOAuthClient: () => ({
      getUserTokens: () => (hasUserTokens ? { userAccessToken: 'test-token' } : null),
      getAccessToken: vi.fn().mockResolvedValue('test-token'),
    }),
    getConfig: () => ({ environment: 'production' }),
  } as unknown as EbayApiClient;
}

describe('MediaApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('returns the create response maxDimensionImageUrl instead of the thumbnail URL', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { imageUrl: thumbnailUrl, maxDimensionImageUrl: fullSizeUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-123' },
    });

    const result = await new MediaApi(makeClient()).createImageFromUrl(
      'https://supplier.example/image.jpg'
    );

    expect(result).toEqual({ id: 'image-123', imageUrl: fullSizeUrl, description: undefined });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('sends processed local files as a JPEG binary body, not multipart form data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ebay-media-test-'));
    const imagePath = join(directory, 'source.png');
    await writeFile(
      imagePath,
      await sharp({ create: { width: 500, height: 500, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer()
    );
    vi.mocked(axios.post).mockResolvedValue({
      data: { maxDimensionImageUrl: fullSizeUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-456' },
    });

    try {
      const result = await new MediaApi(makeClient()).createImageFromFile(imagePath);
      expect(result).toEqual({ id: 'image-456', imageUrl: fullSizeUrl, description: undefined });
      expect(axios.post).toHaveBeenCalledWith(
        'https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file',
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'image/jpeg',
            Accept: 'application/json',
          }),
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects app-token fallback before making a Media API request', async () => {
    await expect(
      new MediaApi(makeClient(false)).createImageFromUrl('https://supplier.example/image.jpg')
    ).rejects.toThrow('seller user OAuth credentials with the sell.inventory scope');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
