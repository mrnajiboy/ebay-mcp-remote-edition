import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import sharp from 'sharp';
import { MediaApi } from '@/api/media/media.js';
import type { EbayApiClient } from '@/api/client.js';

vi.mock('axios');

function makeClient(): EbayApiClient {
  return {
    getOAuthClient: () => ({ getAccessToken: vi.fn().mockResolvedValue('test-token') }),
    getConfig: () => ({ environment: 'production' }),
  } as unknown as EbayApiClient;
}

describe('MediaApi forced local URL processing', () => {
  it('downloads, Sharp-processes, and uploads URL input through the binary endpoint', async () => {
    const sourceImage = await sharp({
      create: { width: 750, height: 750, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: sourceImage })
      .mockResolvedValueOnce({
        data: {
          id: 'image-789',
          imageUrl: 'https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/example/s-l1600.jpg',
        },
      });
    vi.mocked(axios.post).mockResolvedValue({
      data: { id: 'image-789' },
      headers: {},
    });

    const result = await new MediaApi(makeClient()).createImageFromUrlWithLocalProcessing(
      'https://supplier.example/image.png',
      'product image'
    );

    expect(result).toEqual({
      id: 'image-789',
      imageUrl: 'https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/example/s-l1600.jpg',
      description: undefined,
    });
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://supplier.example/image.png',
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
    expect(axios.post).toHaveBeenCalledWith(
      'https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file',
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
