import { AccountApi } from '@/api/account-management/account.js';
import { AnalyticsApi } from '@/api/analytics-and-report/analytics.js';
import { EbayApiClient } from '@/api/client.js';
import { FeedbackApi } from '@/api/communication/feedback.js';
import { MessageApi } from '@/api/communication/message.js';
import { NegotiationApi } from '@/api/communication/negotiation.js';
import { NotificationApi } from '@/api/communication/notification.js';
import { DeveloperApi } from '@/api/developer/developer.js';
import { InventoryApi } from '@/api/listing-management/inventory.js';
import { MetadataApi } from '@/api/listing-metadata/metadata.js';
import { TaxonomyApi } from '@/api/listing-metadata/taxonomy.js';
import { MarketingApi } from '@/api/marketing-and-promotions/marketing.js';
import { RecommendationApi } from '@/api/marketing-and-promotions/recommendation.js';
import { DisputeApi } from '@/api/order-management/dispute.js';
import { FulfillmentApi } from '@/api/order-management/fulfillment.js';
import { ComplianceApi } from '@/api/other/compliance.js';
import { EDeliveryApi } from '@/api/other/edelivery.js';
import { IdentityApi } from '@/api/other/identity.js';
import { TranslationApi } from '@/api/other/translation.js';
import { VeroApi } from '@/api/other/vero.js';
import { TradingApiClient } from '@/api/client-trading.js';
import { TradingApi } from '@/api/trading/trading.js';
import type { EbayConfig } from '@/types/ebay.js';

export class EbaySellerApi {
  private client: EbayApiClient;
  public account: AccountApi;
  public inventory: InventoryApi;
  public fulfillment: FulfillmentApi;
  public dispute: DisputeApi;
  public marketing: MarketingApi;
  public recommendation: RecommendationApi;
  public analytics: AnalyticsApi;
  public metadata: MetadataApi;
  public taxonomy: TaxonomyApi;
  public negotiation: NegotiationApi;
  public message: MessageApi;
  public notification: NotificationApi;
  public feedback: FeedbackApi;
  public identity: IdentityApi;
  public compliance: ComplianceApi;
  public vero: VeroApi;
  public translation: TranslationApi;
  public edelivery: EDeliveryApi;
  public developer: DeveloperApi;
  public trading: TradingApi;

  constructor(
    config: EbayConfig,
    context?: {
      userId?: string;
      environment?: 'production' | 'sandbox';
    }
  ) {
    this.client = new EbayApiClient(config, context);
    this.account = new AccountApi(this.client);
    this.inventory = new InventoryApi(this.client);
    this.fulfillment = new FulfillmentApi(this.client);
    this.dispute = new DisputeApi(this.client);
    this.marketing = new MarketingApi(this.client);
    this.recommendation = new RecommendationApi(this.client);
    this.analytics = new AnalyticsApi(this.client);
    this.metadata = new MetadataApi(this.client);
    this.taxonomy = new TaxonomyApi(this.client);
    this.negotiation = new NegotiationApi(this.client);
    this.message = new MessageApi(this.client);
    this.notification = new NotificationApi(this.client);
    this.feedback = new FeedbackApi(this.client);
    this.identity = new IdentityApi(this.client);
    this.compliance = new ComplianceApi(this.client);
    this.vero = new VeroApi(this.client);
    this.translation = new TranslationApi(this.client);
    this.edelivery = new EDeliveryApi(this.client);
    this.developer = new DeveloperApi(this.client);
    const tradingClient = new TradingApiClient(this.client);
    this.trading = new TradingApi(tradingClient);
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  isAuthenticated(): boolean {
    return this.client.isAuthenticated();
  }

  hasUserTokens(): boolean {
    return this.client.hasUserTokens();
  }

  async setUserTokens(
    accessToken: string,
    refreshToken: string,
    accessTokenExpiry?: number,
    refreshTokenExpiry?: number
  ): Promise<void> {
    await this.client.setUserTokens(accessToken, refreshToken, accessTokenExpiry, refreshTokenExpiry);
  }

  getAuthClient(): EbayApiClient {
    return this.client;
  }

  getTokenInfo() {
    return this.client.getTokenInfo();
  }
}

export * from '@/api/account-management/account.js';
export * from '@/api/analytics-and-report/analytics.js';
export * from '@/api/client.js';
export * from '@/api/communication/feedback.js';
export * from '@/api/communication/message.js';
export * from '@/api/communication/negotiation.js';
export * from '@/api/communication/notification.js';
export * from '@/api/listing-management/inventory.js';
export * from '@/api/listing-metadata/metadata.js';
export * from '@/api/listing-metadata/taxonomy.js';
export * from '@/api/marketing-and-promotions/marketing.js';
export * from '@/api/marketing-and-promotions/recommendation.js';
export * from '@/api/order-management/dispute.js';
export * from '@/api/order-management/fulfillment.js';
export * from '@/api/other/compliance.js';
export * from '@/api/other/edelivery.js';
export * from '@/api/other/identity.js';
export * from '@/api/other/translation.js';
export * from '@/api/other/vero.js';
export * from '@/api/developer/developer.js';
export * from '@/api/trading/trading.js';
export * from '@/api/client-trading.js';
