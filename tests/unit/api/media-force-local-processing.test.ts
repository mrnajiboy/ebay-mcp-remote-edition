import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaApi } from '@/api/media/media.js';
import type { EbayApiClient } from '@/api/client.js';

vi.mock('axios');

function makeClient(): EbayApiClient {
  return {
    getOAuthClient: () => ({ getAccessToken: vi.fn().mockResolvedValue('test-token') }),
    getConfig: () => ({ environment: 'production' }),
  } as unknown as EbayApiClient;
}

const fullSizeUrl = 'https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/example/s-l1600.jpg';

describe('MediaApi forced local URL processing', () => {
  it('delegates URL sources through createImageFromFile with a temp file', async () => {
    // Create a valid source PNG to simulate a downloaded URL
    const sourceImage = await sharp({
      create: { width: 750, height: 750, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    vi.mocked(axios.get).mockResolvedValue({ data: sourceImage });
    vi.mocked(axios.post).mockResolvedValue({
      data: { maxDimensionImageUrl: fullSizeUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-456' },
    });

    const result = await new MediaApi(makeClient()).createImageFromUrlWithLocalProcessing(
      'https://supplier.example/image.png',
      'product image'
    );

    // Result should resolve to the full-size URL from maxDimensionImageUrl
    expect(result).toEqual({
      id: 'image-456',
      imageUrl: fullSizeUrl,
      description: undefined,
    });

    // Must download the URL first
    expect(axios.get).toHaveBeenCalledWith(
      'https://supplier.example/image.png',
      expect.objectContaining({ responseType: 'arraybuffer' })
    );

    // Must upload through create_image_from_file with multipart/form-data
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/create_image_from_file'),
      expect.any(Buffer),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': expect.stringMatching(/^multipart\/form-data; boundary=/),
        }),
      })
    );
  });
});
