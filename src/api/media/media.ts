import type { EbayApiClient } from '../client.js';
import {
  processImageForUpload,
  validateImageForEbay as _validateImageForEbay,
} from '@/utils/image-processor.js';
import axios, { type AxiosResponse } from 'axios';
import * as fs from 'fs';

/**
 * Commerce Media API (v1_beta) - Upload and manage images via eBay Picture Services
 * Based on: https://developer.ebay.com/api-docs/commerce/media/resources/image/from_url/methods
 */
export class MediaApi {
  private readonly basePath = '/commerce/media/v1_beta';

  constructor(private client: EbayApiClient) {}

  private async getAccessToken(): Promise<string> {
    const oauthClient = this.client.getOAuthClient();
    if (!oauthClient.getUserTokens()) {
      throw new Error(
        'eBay Picture Services requires seller user OAuth credentials with the sell.inventory scope; app access tokens cannot upload listing images.'
      );
    }
    return await oauthClient.getAccessToken();
  }

  private getMediaBaseUrl(): string {
    const env = this.client.getConfig().environment;
    return env === 'production' ? 'https://apim.ebay.com' : 'https://apim.sandbox.ebay.com';
  }

  /**
   * Upload an image from a public URL to eBay Picture Services.
   *
   * Primary flow: Pass URL directly to eBay's createImageFromUrl endpoint
   * (eBay downloads and processes server-side — no local processing needed).
   *
   * Fallback: If eBay rejects the image (e.g., too small for 500px minimum),
   * download → enlarge with Sharp → upload via createImageFromFile.
   *
   * Supported source formats: JPG, GIF, PNG, BMP, TIFF, AVIF, HEIC, WEBP
   * Max file size: 10MB per image
   *
   * @param imageUrl - Public URL of the image to upload
   * @param description - Optional description for the image
   * @returns Object with image ID and eBay-hosted image URL
   */
  async createImageFromUrl(
    imageUrl: string,
    description?: string
  ): Promise<{ id: string; imageUrl: string; description?: string }> {
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new Error('imageUrl is required and must be a string');
    }

    const token = await this.getAccessToken();
    const baseUrl = this.getMediaBaseUrl();

    try {
      // Primary: Pass URL directly to eBay — they handle server-side download
      const body: Record<string, unknown> = { imageUrl };
      if (description) {
        body.description = description;
      }

      const createResponse = await axios.post(
        `${baseUrl}${this.basePath}/image/create_image_from_url`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Prefer: 'return=representation',
          },
          timeout: 30000,
        }
      );

      return await this.resolveCreatedImage(createResponse);
    } catch (primaryError) {
      // Fallback: if eBay rejects (e.g., image too small), download → Sharp enlarge → upload via file
      if (axios.isAxiosError(primaryError)) {
        const status = primaryError.response?.status;
        // Only fallback on errors that suggest image quality/size issues
        if (status && (status === 400 || status === 500)) {
          try {
            console.log(
              `[MediaApi] Direct URL upload failed (status ${status}), falling back to Sharp processing for: ${imageUrl}`
            );

            // Download the image
            const downloadResponse = await axios.get(imageUrl, {
              responseType: 'arraybuffer',
              timeout: 30000,
              maxContentLength: 10 * 1024 * 1024, // 10MB max
            });
            const imageBuffer = Buffer.from(downloadResponse.data);

            // Process with Sharp (enlarge if too small, convert to JPEG)
            const processed = await processImageForUpload(imageBuffer);

            // Upload via file endpoint
            return await this.uploadProcessedImage(processed.buffer, token, baseUrl);
          } catch {
            // If fallback also fails, throw the original error (more actionable)
            throw primaryError;
          }
        }
      }
      // Re-throw non-retryable errors as-is
      if (axios.isAxiosError(primaryError)) {
        const status = primaryError.response?.status;
        const data = primaryError.response?.data;
        const message =
          typeof data === 'object' && data !== null && 'errors' in data
            ? (data.errors as any[])?.[0]?.longMessage ||
              (data.errors as any[])?.[0]?.message ||
              primaryError.message
            : primaryError.message;
        throw new Error(`Failed to upload image from URL (status ${status}): ${message}`, {
          cause: primaryError,
        });
      }
      throw new Error(
        `Failed to upload image from URL: ${primaryError instanceof Error ? primaryError.message : 'Unknown error'}`,
        { cause: primaryError }
      );
    }
  }

  /**
   * Upload an image from a local file to eBay Picture Services.
   *
   * Endpoint: POST /commerce/media/v1/image/create_image_from_file
   * Content-Type: multipart/form-data
   *
   * Supported formats: JPG, GIF, PNG, BMP, TIFF, AVIF, HEIC, WEBP
   * Max file size: 10MB per image
   *
   * @param filePath - Local file path of the image to upload
   * @param description - Optional description for the image
   * @returns Object with image ID and eBay-hosted image URL
   */
  async createImageFromFile(
    filePath: string,
    _description?: string
  ): Promise<{ id: string; imageUrl: string; description?: string }> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('filePath is required and must be a string');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const token = await this.getAccessToken();
    const baseUrl = this.getMediaBaseUrl();

    try {
      const fileBuffer = fs.readFileSync(filePath);

      // Process image — validate dimensions, enlarge to min 500px if too small,
      // convert to JPEG, and optimize. Uses sharp library.
      const processed = await processImageForUpload(fileBuffer);

      return await this.uploadProcessedImage(processed.buffer, token, baseUrl);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data;
        const message =
          typeof data === 'object' && data !== null && 'errors' in data
            ? (data.errors as any[])?.[0]?.longMessage ||
              (data.errors as any[])?.[0]?.message ||
              error.message
            : error.message;
        throw new Error(`Failed to upload image from file (status ${status}): ${message}`, {
          cause: error,
        });
      }
      throw new Error(
        `Failed to upload image from file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error }
      );
    }
  }

  /**
   * Upload a processed image buffer to eBay Picture Services.
   *
   * @param buffer - Processed image buffer
   * @param metadata - Image metadata
   * @param token - OAuth access token
   * @param baseUrl - Media API base URL
   * @param description - Optional description
   * @returns Object with image ID and eBay-hosted image URL
   */
  private async uploadProcessedImage(
    buffer: Buffer,
    token: string,
    baseUrl: string
  ): Promise<{ id: string; imageUrl: string; description?: string }> {
    const createResponse = await axios.post(
      `${baseUrl}${this.basePath}/image/create_image_from_file`,
      buffer,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/jpeg',
          Accept: 'application/json',
          Prefer: 'return=representation',
        },
        timeout: 30000,
      }
    );

    return await this.resolveCreatedImage(createResponse);
  }

  /**
   * The Media API's create responses include maxDimensionImageUrl. Use it directly:
   * imageUrl can be a gallery thumbnail (for example, 80x80), while the max-dimension
   * URL is the listing-safe rendition of the uploaded original.
   */
  private async resolveCreatedImage(
    response: Pick<AxiosResponse, 'data' | 'headers'>
  ): Promise<{ id: string; imageUrl: string; description?: string }> {
    const data = response.data as Record<string, unknown>;
    const location = response.headers.location;
    const imageId =
      (typeof data.id === 'string' && data.id) ||
      (typeof data.imageId === 'string' && data.imageId) ||
      (typeof location === 'string' ? location.split('/').pop() : undefined);
    const imageUrl =
      (typeof data.maxDimensionImageUrl === 'string' && data.maxDimensionImageUrl) ||
      (typeof data.imageUrl === 'string' && data.imageUrl);

    if (imageUrl) {
      return {
        id: imageId || '',
        imageUrl,
        description: typeof data.description === 'string' ? data.description : undefined,
      };
    }
    if (!imageId) {
      throw new Error('No image URL or image ID returned from create endpoint');
    }
    return await this.getImage(imageId);
  }

  /**
   * Get image details including the eBay-hosted URL.
   *
   * @param imageId - The image ID returned from createImageFromUrl
   * @returns Image details including hosted URL
   */
  async getImage(imageId: string): Promise<{ id: string; imageUrl: string; description?: string }> {
    if (!imageId || typeof imageId !== 'string') {
      throw new Error('imageId is required and must be a string');
    }

    const token = await this.getAccessToken();
    const baseUrl = this.getMediaBaseUrl();

    try {
      const response = await axios.get(`${baseUrl}${this.basePath}/image/${imageId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 30000,
      });

      const data = response.data as Record<string, unknown>;
      const imageUrl =
        (typeof data.maxDimensionImageUrl === 'string' && data.maxDimensionImageUrl) ||
        (typeof data.imageUrl === 'string' && data.imageUrl) ||
        '';
      return {
        id: (typeof data.id === 'string' && data.id) || imageId,
        imageUrl,
        description: typeof data.description === 'string' ? data.description : undefined,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data;
        const message =
          typeof data === 'object' && data !== null && 'errors' in data
            ? (data.errors as any[])?.[0]?.longMessage ||
              (data.errors as any[])?.[0]?.message ||
              error.message
            : error.message;
        throw new Error(`Failed to get image details (status ${status}): ${message}`, {
          cause: error,
        });
      }
      throw new Error(
        `Failed to get image details: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error }
      );
    }
  }
}
