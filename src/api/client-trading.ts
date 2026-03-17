import axios from 'axios';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { EbayApiClient } from '@/api/client.js';
import { apiLogger } from '@/utils/logger.js';

const COMPAT_LEVEL = '1451';
const SITE_ID = '0';

export class TradingApiClient {
  private restClient: EbayApiClient;
  private baseUrl: string;
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor(restClient: EbayApiClient) {
    this.restClient = restClient;
    const env = restClient.getConfig().environment;
    this.baseUrl =
      env === 'sandbox'
        ? 'https://api.sandbox.ebay.com'
        : 'https://api.ebay.com';

    this.parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      parseTagValue: true,
      isArray: (_name: string) => {
        const arrayTags = [
          'Item',
          'Errors',
          'Error',
          'NameValueList',
          'Value',
          'ShippingServiceOptions',
          'InternationalShippingServiceOption',
          'PaymentMethods',
          'PictureURL',
          'CompatibilityList',
          'Variation',
        ];
        return arrayTags.includes(_name);
      },
    });

    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async execute(
    callName: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = await this.restClient.getOAuthClient().getAccessToken();

    const requestTag = `${callName}Request`;
    const responseTag = `${callName}Response`;

    const xmlObj: Record<string, unknown> = {};
    xmlObj[requestTag] = {
      '@_xmlns': 'urn:ebay:apis:eBLBaseComponents',
      ...params,
    };

    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>\n${this.builder.build(xmlObj)}`;

    apiLogger.debug(`Trading API ${callName}`, { xmlBody });

    let response;
    try {
      response = await axios.post(`${this.baseUrl}/ws/api.dll`, xmlBody, {
        headers: {
          'X-EBAY-API-SITEID': SITE_ID,
          'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
          'X-EBAY-API-CALL-NAME': callName,
          'X-EBAY-API-IAF-TOKEN': token,
          'Content-Type': 'text/xml',
        },
        timeout: 30000,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown HTTP error';
      throw new Error(`Trading API ${callName} request failed: ${message}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = this.parser.parse(response.data) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `Failed to parse Trading API ${callName} response: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const result = (parsed[responseTag] || parsed) as Record<string, unknown>;

    // Log warnings without failing
    if (result.Ack === 'Warning') {
      apiLogger.warn(`Trading API ${callName} returned warnings`, {
        errors: result.Errors,
      });
    }

    // Check for eBay errors
    if (result.Ack === 'Failure' || result.Ack === 'PartialFailure') {
      const errors = result.Errors;
      const firstError = Array.isArray(errors) ? errors[0] : errors;
      const message =
        firstError?.ShortMessage ||
        firstError?.LongMessage ||
        'Unknown Trading API error';
      throw new Error(message);
    }

    return result;
  }
}