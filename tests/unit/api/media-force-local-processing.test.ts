import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const fullSizeUrl = 'https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/example/s-l1600.jpg';
const placeholderUrl = 'https://i.ebayimg.com/images/g/example/s-l57.jpg';
const imageReadbackUrl = 'https://apim.ebay.com/commerce/media/v1_beta/image/image-placeholder';

async function createJpeg(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .toBuffer();
}

describe('MediaApi hosted rendition verification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('delegates URL sources through createImageFromFile and verifies the returned rendition', async () => {
    const sourceImage = await createJpeg(750, 750);

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: sourceImage })
      .mockResolvedValueOnce({ data: sourceImage });
    vi.mocked(axios.post).mockResolvedValue({
      data: { maxDimensionImageUrl: fullSizeUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-456' },
    });

    const result = await new MediaApi(makeClient()).createImageFromUrlWithLocalProcessing(
      'https://supplier.example/image.jpg',
      'product image'
    );

    expect(result).toEqual({
      id: 'image-456',
      imageUrl: fullSizeUrl,
      description: undefined,
    });
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://supplier.example/image.jpg',
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      fullSizeUrl,
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
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

  it('rejects nominal URL-ingest success when eBay returns an 80px placeholder', async () => {
    const placeholder = await createJpeg(80, 80);

    vi.mocked(axios.post).mockResolvedValue({
      data: { imageUrl: placeholderUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-placeholder' },
    });
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { imageUrl: placeholderUrl } })
      .mockResolvedValueOnce({ data: placeholder });

    await expect(
      new MediaApi(makeClient()).createImageFromUrl('https://supplier.example/image.jpg')
    ).rejects.toThrow('80x80');

    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      imageReadbackUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      placeholderUrl,
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
  });

  it('rejects URL-ingest success when the hosted rendition cannot be downloaded', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { imageUrl: placeholderUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-placeholder' },
    });
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { imageUrl: placeholderUrl } })
      .mockRejectedValueOnce(new Error('network unavailable'));

    await expect(
      new MediaApi(makeClient()).createImageFromUrl('https://supplier.example/image.jpg')
    ).rejects.toThrow('Unable to download eBay-hosted image for verification');
  });

  it('rejects URL-ingest success when the hosted rendition is not decodable', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { imageUrl: placeholderUrl },
      headers: { location: '/commerce/media/v1_beta/image/image-placeholder' },
    });
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { imageUrl: placeholderUrl } })
      .mockResolvedValueOnce({ data: Buffer.from('not an image') });

    await expect(
      new MediaApi(makeClient()).createImageFromUrl('https://supplier.example/image.jpg')
    ).rejects.toThrow('eBay-hosted image is not decodable');
  });
});
