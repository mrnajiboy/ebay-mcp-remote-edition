import type { EbayApiClient } from '@/api/client.js';

/**
 * Translation API - Translation services
 * Based on: docs/sell-apps/other-apis/commerce_translation_v1_beta_oas3.json
 */
export class TranslationApi {
  private readonly basePath = '/commerce/translation/v1';

  constructor(private client: EbayApiClient) {}

  /**
   * Translate listing text
   */
  async translate(from: string, to: string, translationContext: string, text: string[]) {
    return await this.client.post(`${this.basePath}/translate`, {
      from,
      to,
      translationContext,
      text,
    });
  }
}
