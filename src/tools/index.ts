import type { EbaySellerApi } from '@/api/index.js';
import {
  getOAuthAuthorizationUrl,
  validateScopes,
  getEbayConfig,
  getConfiguredEnvironment,
} from '@/config/environment.js';
import {
  accountTools,
  analyticsTools,
  browseTools,
  communicationTools,
  developerTools,
  fulfillmentTools,
  inventoryTools,
  marketingTools,
  metadataTools,
  otherApiTools,
  taxonomyTools,
  tradingTools,
  tokenManagementTools,
  type ToolDefinition,
} from '@/tools/definitions/index.js';
import { chatGptTools } from '@/tools/chat-tools.js';
import { getApiStatusFeed } from '@/utils/api-status-feed.js';
import { convertToTimestamp, validateTokenExpiry } from '@/utils/date-converter.js';

/**
 * Tools disabled at config level because the eBay seller account doesn't support them.
 * These tools return errors when called, so we exclude them from the tool list entirely.
 *
 * Categories:
 * - Commerce Shipping: account not enrolled in commerce shipping services
 * - VERO (Vendor Enforcement of Rights Online): account not enrolled in VERO program
 * - Signing Keys: account doesn't have signing key permissions
 *
 * @see TASK-MCP.6 — Disable unsupported tools (config-level tools.exclude)
 */
const EXCLUDED_TOOLS = new Set([
  // Commerce Shipping (account not enrolled)
  'ebay_get_shipping_services',
  'ebay_get_dropoff_sites',
  'ebay_get_consign_preferences',
  'ebay_get_battery_qualifications',
  // VERO (account not enrolled)
  'ebay_get_vero_reason_codes',
  'ebay_create_vero_report',
  // Signing Keys (account doesn't have permissions)
  'ebay_suppress_violation',
  'ebay_get_signing_keys',
  'ebay_create_signing_key',
]);

// Import Zod schemas for input validation
import {
  getAwaitingFeedbackSchema,
  getFeedbackRatingSummarySchema,
  getFeedbackSchema,
  leaveFeedbackForBuyerSchema,
  respondToFeedbackSchema,
} from '@/utils/communication/feedback.js';
import {
  bulkUpdateConversationSchema,
  getConversationSchema,
  getConversationsSchema,
  sendMessageSchema,
  updateConversationSchema,
} from '@/utils/communication/message.js';
import {
  findEligibleItemsSchema,
  getOffersToBuyersSchema,
  sendOfferToInterestedBuyersSchema,
} from '@/utils/communication/negotiation.js';
import {
  createDestinationSchema,
  createSubscriptionFilterSchema,
  createSubscriptionSchema,
  deleteDestinationSchema,
  deleteSubscriptionFilterSchema,
  deleteSubscriptionSchema,
  disableSubscriptionSchema,
  enableSubscriptionSchema,
  getConfigSchema,
  getDestinationSchema,
  getPublicKeySchema,
  getSubscriptionFilterSchema,
  getSubscriptionSchema,
  getSubscriptionsSchema,
  getTopicSchema,
  getTopicsSchema,
  testSubscriptionSchema,
  updateConfigSchema,
  updateDestinationSchema,
  updateSubscriptionSchema,
} from '@/utils/communication/notification.js';

/** Deep merge source into target, returning new object */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    if (sVal && typeof sVal === 'object' && !Array.isArray(sVal)) {
      const tVal = (result as Record<string, unknown>)[key];
      (result as Record<string, unknown>)[key] = deepMerge(
        tVal && typeof tVal === 'object' && !Array.isArray(tVal)
          ? (tVal as Record<string, unknown>)
          : {},
        sVal as Record<string, unknown>
      );
    } else if (sVal !== undefined) {
      (result as Record<string, unknown>)[key] = sVal;
    }
  }
  return result;
}
export type { ToolDefinition };

/**
 * Normalize enum values that LLMs often send in wrong formats
 * (lowercase, plural, hyphenated) to eBay API uppercase snake_case format
 */
function normalizeEnumValue(value: string): string {
  return value.toUpperCase().replace(/-/g, '_').replace(/S$/, ''); // Remove trailing S (e.g., "DAYS" -> "DAY")
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInventoryBackedReviseFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('inventory-based listing management') ||
    normalized.includes('please refer to the tool used to create this listing') ||
    normalized.includes('not allowed for inventory items') ||
    normalized.includes('not allowed for inventory')
  );
}

function extractListingSku(listing: Record<string, unknown>): string | undefined {
  const directSku = listing.SKU ?? listing.Sku ?? listing.sku;
  if (typeof directSku === 'string' && directSku.trim()) return directSku;

  const item = listing.Item as Record<string, unknown> | undefined;
  const nestedSku = item?.SKU ?? item?.Sku ?? item?.sku;
  return typeof nestedSku === 'string' && nestedSku.trim() ? nestedSku : undefined;
}

function extractOfferList(response: unknown): Record<string, unknown>[] {
  if (Array.isArray(response)) return response as Record<string, unknown>[];
  if (!response || typeof response !== 'object') return [];

  const record = response as Record<string, unknown>;
  const offers = record.offers ?? record.Offers;
  return Array.isArray(offers) ? (offers as Record<string, unknown>[]) : [];
}

function extractOfferId(offer: Record<string, unknown>): string | undefined {
  const id = offer.offerId ?? offer.OfferID ?? offer.id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

function findOfferForListing(
  offers: Record<string, unknown>[],
  itemId: string
): Record<string, unknown> | undefined {
  return (
    offers.find((offer) => {
      const listing = offer.listing as Record<string, unknown> | undefined;
      const listingId =
        offer.listingId ?? offer.ListingID ?? listing?.listingId ?? listing?.ListingID;
      const safeId =
        typeof listingId === 'string' || typeof listingId === 'number' ? String(listingId) : '';
      return safeId === itemId;
    }) ?? offers[0]
  );
}

function normalizePriceForInventory(price: unknown): { value: string; currency: string } {
  if (typeof price === 'number' || typeof price === 'string') {
    return { value: String(price), currency: 'USD' };
  }

  if (price && typeof price === 'object') {
    const record = price as Record<string, unknown>;
    const value = record.value ?? record['#text'];
    const currency = record.currency ?? record.currencyID ?? record['@_currencyID'] ?? 'USD';
    if (value !== undefined) {
      const valueStr =
        typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : JSON.stringify(value);
      const currencyStr =
        typeof currency === 'string' || typeof currency === 'number'
          ? String(currency)
          : JSON.stringify(currency);
      return { value: valueStr, currency: currencyStr };
    }
  }

  throw new Error('StartPrice must be a string, number, or { value, currency } object');
}

async function reviseInventoryBackedListing(
  api: EbaySellerApi,
  itemId: string,
  fields: Record<string, unknown>,
  tradingErrorMessage: string
): Promise<Record<string, unknown>> {
  const listing = await api.trading.getListing(itemId);
  const sku = extractListingSku(listing);
  if (!sku) {
    throw new Error(
      `Trading revise failed (${tradingErrorMessage}) and Inventory API fallback could not find SKU for listing ${itemId}`
    );
  }

  const offersResponse = await api.inventory.getOffers(sku, undefined, 50);
  const offerSummary = findOfferForListing(extractOfferList(offersResponse), itemId);
  const offerId = offerSummary ? extractOfferId(offerSummary) : undefined;
  if (!offerId) {
    throw new Error(
      `Trading revise failed (${tradingErrorMessage}) and Inventory API fallback could not find offer for SKU ${sku}`
    );
  }

  const updated: string[] = [];
  const unsupported: string[] = [];
  let offerNeedsUpdate = false;
  let inventoryNeedsUpdate = false;

  const offer = (await api.inventory.getOffer(offerId)) as Record<string, unknown>;
  const inventoryItem = (await api.inventory.getInventoryItem(sku)) as Record<string, unknown>;

  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case 'StartPrice':
        offer.pricingSummary = {
          ...(offer.pricingSummary ?? {}),
          price: normalizePriceForInventory(value),
        };
        offerNeedsUpdate = true;
        updated.push(key);
        break;
      case 'Quantity':
        offer.availableQuantity = Number(value);
        offerNeedsUpdate = true;
        updated.push(key);
        break;
      case 'Description':
        offer.listingDescription = value;
        offerNeedsUpdate = true;
        updated.push(key);
        break;
      case 'Title':
        inventoryItem.product = {
          ...(inventoryItem.product ?? {}),
          title: value,
        };
        inventoryNeedsUpdate = true;
        updated.push(key);
        break;
      default:
        unsupported.push(key);
        break;
    }
  }

  if (unsupported.length > 0) {
    throw new Error(
      `Inventory API revise fallback does not support field(s): ${unsupported.join(', ')}. Supported fields: Title, Description, Quantity, StartPrice.`
    );
  }

  if (inventoryNeedsUpdate) {
    await api.inventory.createOrReplaceInventoryItem(sku, inventoryItem);
  }
  if (offerNeedsUpdate) {
    await api.inventory.updateOffer(offerId, offer);
  }

  return {
    Ack: 'Success',
    mode: 'inventory-api-fallback',
    ItemID: itemId,
    sku,
    offerId,
    updatedFields: updated,
    tradingFallbackReason: tradingErrorMessage,
  };
}

/**
 * Normalize time duration unit values
 */
function normalizeTimeUnit(value: string): string {
  const normalized = value.toUpperCase().replace(/-/g, '_');
  const timeUnitMap: Record<string, string> = {
    DAY: 'DAY',
    DAYS: 'DAY',
    BUSINESS_DAY: 'BUSINESS_DAY',
    BUSINESS_DAYS: 'BUSINESS_DAY',
    CALENDAR_DAY: 'CALENDAR_DAY',
    HOUR: 'HOUR',
    HOURS: 'HOUR',
    MINUTE: 'MINUTE',
    MINUTES: 'MINUTE',
    SECOND: 'SECOND',
    SECONDS: 'SECOND',
    MONTH: 'MONTH',
    MONTHS: 'MONTH',
    YEAR: 'YEAR',
    YEARS: 'YEAR',
  };
  return timeUnitMap[normalized] || normalized;
}

/**
 * Get all tool definitions for the MCP server
 * Filters out tools the eBay seller account doesn't support (see EXCLUDED_TOOLS)
 */
export function getToolDefinitions(): ToolDefinition[] {
  const chatConnectorTools = chatGptTools.filter(
    (tool) => tool.name === 'search' || tool.name === 'fetch'
  );
  const allTools = [
    ...chatConnectorTools,
    ...tokenManagementTools,
    ...accountTools,
    ...inventoryTools,
    ...fulfillmentTools,
    ...marketingTools,
    ...analyticsTools,
    ...metadataTools,
    ...taxonomyTools,
    ...browseTools,
    ...communicationTools,
    ...otherApiTools,
    ...developerTools,
    ...tradingTools,
  ];
  // Filter out tools the account doesn't support
  return allTools.filter((tool) => !EXCLUDED_TOOLS.has(tool.name));
}

/**
 * Execute a tool based on its name
 */
export async function executeTool(
  api: EbaySellerApi,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    // ChatGPT Connector Tools
    case 'search': {
      // For this example, we'll treat the query as a search for inventory items.
      // A more robust implementation might search across different types of content.
      const requestedLimitRaw = args.limit as number | undefined;
      const limit =
        typeof requestedLimitRaw === 'number' && Number.isFinite(requestedLimitRaw)
          ? Math.max(Math.floor(requestedLimitRaw), 1)
          : 10;
      const query = (args.query as string | undefined)?.toLowerCase().trim();
      const pageSize = query ? Math.min(Math.max(limit, 50), 200) : limit;
      const matches: {
        product?: { title?: string };
        sku: string;
      }[] = [];
      let offset = 0;

      while (matches.length < limit) {
        const response = await api.inventory.getInventoryItems(pageSize, offset);
        const pageItems = response.inventoryItems ?? [];
        if (pageItems.length === 0) {
          break;
        }

        // Filter to only include items with valid SKUs (required for getInventoryItem calls)
        const itemsWithSku = pageItems.filter(
          (item): item is typeof item & { sku: string } =>
            typeof item.sku === 'string' && item.sku.trim() !== ''
        );

        const filtered = query
          ? itemsWithSku.filter((item) => (item.product?.title ?? '').toLowerCase().includes(query))
          : itemsWithSku;

        matches.push(...filtered);
        offset += pageSize;

        const total = (response as { total?: number }).total;
        if (typeof total === 'number' && offset >= total) {
          break;
        }

        if (!query || pageItems.length < pageSize) {
          break;
        }
      }

      const results = matches.slice(0, limit).map((item) => ({
        id: item.sku,
        title: item.product?.title ?? 'No Title',
        // The URL should be a canonical link to the item, which we don't have here.
        // We'll use a placeholder.
        url: `https://www.ebay.com/`, // Placeholder URL
      }));

      // Format the response as required by the ChatGPT connector spec.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ results }),
          },
        ],
      };
    }

    case 'fetch': {
      const sku = args.id as string;
      const item = await api.inventory.getInventoryItem(sku);

      // Format the response as required by the ChatGPT connector spec.
      const result = {
        id: sku,
        title: item.product?.title ?? 'No Title',
        text: item.product?.description ?? 'No description available.',
        url: `https://www.ebay.com/`, // Placeholder URL
        metadata: {
          source: 'ebay_inventory',
          aspects: item.product?.aspects,
          condition: item.condition,
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    }

    case 'ebay_get_oauth_url': {
      // Support environment override (PRODUCTION or SANDBOX)
      const requestedEnv = (args.environment as string | undefined)?.toUpperCase();
      const environment = requestedEnv === 'SANDBOX' ? 'sandbox' : 'production';

      // Use getEbayConfig which supports multi-env vars:
      // EBAY_PRODUCTION_CLIENT_ID / EBAY_SANDBOX_CLIENT_ID
      // EBAY_PRODUCTION_CLIENT_SECRET / EBAY_SANDBOX_CLIENT_SECRET
      // EBAY_PRODUCTION_RUNAME / EBAY_SANDBOX_RUNAME
      // Falls back to EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME
      const config = getEbayConfig(environment);
      const clientId = config.clientId;

      // Use redirectUri from args if provided, otherwise use from config
      const redirectUri = (args.redirectUri as string | undefined) ?? config.redirectUri;
      const scopes = args.scopes as string[] | undefined;
      const state = args.state as string | undefined;

      if (!clientId) {
        const envHint =
          environment === 'production' ? 'EBAY_PRODUCTION_CLIENT_ID' : 'EBAY_SANDBOX_CLIENT_ID';
        throw new Error(
          `Client ID is required to generate OAuth URL. Set ${envHint} or EBAY_CLIENT_ID.`
        );
      }

      if (!redirectUri) {
        const envHint =
          environment === 'production' ? 'EBAY_PRODUCTION_RUNAME' : 'EBAY_SANDBOX_RUNAME';
        throw new Error(
          `Redirect URI (RuName) is required. Either provide it as a parameter or set ${envHint} or EBAY_RUNAME.`
        );
      }

      // Validate scopes if custom scopes are provided
      let scopeWarnings: string[] = [];
      let validatedScopes = scopes;

      if (scopes && scopes.length > 0) {
        const validation = validateScopes(scopes, environment);
        scopeWarnings = validation.warnings;
        validatedScopes = validation.validScopes;
      }

      const authUrl = getOAuthAuthorizationUrl(
        clientId,
        redirectUri,
        environment,
        validatedScopes,
        state
      );

      const result: Record<string, unknown> = {
        authorizationUrl: authUrl,
        redirectUri,
        instructions:
          'Open this URL in a browser to authorize the application. After authorization, you will be redirected to your redirect URI with an authorization code that can be exchanged for an access token.',
        environment,
        scopes: scopes ?? 'default (all Sell API scopes)',
      };

      // Include warnings if any scopes are invalid for the environment
      if (scopeWarnings.length > 0) {
        result.warnings = scopeWarnings;
      }

      return result;
    }

    case 'ebay_set_user_tokens': {
      const accessToken = args.accessToken as string;
      const refreshToken = args.refreshToken as string;

      if (!accessToken || !refreshToken) {
        throw new Error('Both accessToken and refreshToken are required');
      }

      await api.setUserTokens(accessToken, refreshToken);

      return {
        success: true,
        message:
          'User tokens successfully stored. These tokens will be used for all subsequent API requests and will be automatically refreshed when needed.',
        tokenInfo: api.getTokenInfo(),
      };
    }

    case 'ebay_get_token_status': {
      const tokenInfo = api.getTokenInfo();
      const hasUserTokens = api.hasUserTokens();

      return {
        hasUserToken: tokenInfo.hasUserToken,
        hasAppAccessToken: tokenInfo.hasAppAccessToken,
        authenticated: api.isAuthenticated(),
        currentTokenType: tokenInfo.hasUserToken
          ? 'user_token (10,000-50,000 req/day)'
          : tokenInfo.hasAppAccessToken
            ? 'app_access_token (1,000 req/day)'
            : 'none',
        message: hasUserTokens
          ? 'Using user access token with automatic refresh'
          : 'Using app access token from client credentials flow (lower rate limits). Consider setting user tokens for higher rate limits.',
      };
    }

    case 'ebay_clear_tokens': {
      const authClient = api.getAuthClient().getOAuthClient();
      authClient.clearAllTokens();

      return {
        success: true,
        message:
          'All tokens cleared successfully. You will need to re-authenticate for subsequent API calls.',
      };
    }

    case 'ebay_convert_date_to_timestamp': {
      const dateInput = args.dateInput as string | number;

      try {
        const timestamp = convertToTimestamp(dateInput);

        return {
          success: true,
          timestamp,
          input: dateInput,
          formattedDate: new Date(timestamp).toISOString(),
          message: `Successfully converted to timestamp: ${timestamp}ms (${new Date(timestamp).toISOString()})`,
        };
      } catch (error) {
        throw new Error(
          `Failed to convert date: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    case 'ebay_validate_token_expiry': {
      const accessTokenExpiry = args.accessTokenExpiry as string | number;
      const refreshTokenExpiry = args.refreshTokenExpiry as string | number;

      try {
        // Convert to timestamps
        const accessExpiry = convertToTimestamp(accessTokenExpiry);
        const refreshExpiry = convertToTimestamp(refreshTokenExpiry);

        // Validate
        const validation = validateTokenExpiry(accessExpiry, refreshExpiry);

        return {
          ...validation,
          accessTokenExpiryTimestamp: accessExpiry,
          refreshTokenExpiryTimestamp: refreshExpiry,
          accessTokenExpiryDate: new Date(accessExpiry).toISOString(),
          refreshTokenExpiryDate: new Date(refreshExpiry).toISOString(),
        };
      } catch (error) {
        throw new Error(
          `Failed to validate token expiry: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    case 'ebay_set_user_tokens_with_expiry': {
      const accessToken = args.accessToken as string;
      const refreshToken = args.refreshToken as string;
      const accessTokenExpiry = args.accessTokenExpiry as string | number | undefined;
      const refreshTokenExpiry = args.refreshTokenExpiry as string | number | undefined;
      const autoRefresh = (args.autoRefresh as boolean) ?? true;

      if (!accessToken || !refreshToken) {
        throw new Error('Both accessToken and refreshToken are required');
      }

      try {
        // Convert expiry times to timestamps if provided
        let accessExpiry: number | undefined;
        let refreshExpiry: number | undefined;

        if (accessTokenExpiry !== undefined) {
          accessExpiry = convertToTimestamp(accessTokenExpiry);
        }

        if (refreshTokenExpiry !== undefined) {
          refreshExpiry = convertToTimestamp(refreshTokenExpiry);
        }

        // Set tokens (will use defaults if expiry times not provided)
        await api.setUserTokens(accessToken, refreshToken, accessExpiry, refreshExpiry);

        // If autoRefresh is enabled, attempt to get a fresh access token
        // (The OAuth client will handle refresh internally if needed)
        if (autoRefresh) {
          try {
            const authClient = api.getAuthClient().getOAuthClient();
            await authClient.getAccessToken();

            return {
              success: true,
              message:
                'User tokens stored successfully in memory. Access token validated and refreshed if needed. To persist tokens, update EBAY_USER_REFRESH_TOKEN in .env file.',
              tokenInfo: api.getTokenInfo(),
              refreshed: true,
            };
          } catch (refreshError) {
            return {
              success: true,
              message:
                'User tokens stored, but failed to validate/refresh access token. You may need to re-authorize.',
              tokenInfo: api.getTokenInfo(),
              refreshed: false,
              refreshError: refreshError instanceof Error ? refreshError.message : 'Unknown error',
            };
          }
        }

        return {
          success: true,
          message:
            'User tokens successfully stored in memory. These tokens will be used for all subsequent API requests and will be automatically refreshed when needed. To persist tokens, update EBAY_USER_REFRESH_TOKEN in .env file.',
          tokenInfo: api.getTokenInfo(),
          refreshed: false,
        };
      } catch (error) {
        throw new Error(
          `Failed to set user tokens: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    case 'ebay_display_credentials': {
      // Use getEbayConfig for proper resolution (supports secret config file,
      // per-environment overrides like EBAY_PRODUCTION_CLIENT_ID, etc.)
      const environment = getConfiguredEnvironment();
      const config = getEbayConfig(environment);
      const clientId = config.clientId;
      const clientSecret = config.clientSecret;
      const redirectUri = config.redirectUri;
      const refreshToken = config.refreshToken;

      // Get current token info from API
      const tokenInfo = api.getTokenInfo();
      const authClient = api.getAuthClient().getOAuthClient();

      // Helper function to mask sensitive tokens
      const maskToken = (token: string): string => {
        if (!token || token.length < 12) return '***';
        return `${token.substring(0, 6)}...${token.substring(token.length - 6)}`;
      };

      // Get internal token details from the auth client
      const internalTokens = authClient.getUserTokens();
      const appToken = authClient.getCachedAppAccessToken();
      const appTokenExpiry = authClient.getCachedAppAccessTokenExpiry();

      return {
        credentials: {
          clientId: clientId ? maskToken(clientId) : 'Not set',
          clientSecret: clientSecret ? '****** (set)' : 'Not set',
          environment,
          redirectUri: redirectUri || 'Not set',
        },
        tokens: {
          refreshToken: refreshToken ? maskToken(refreshToken) : 'Not set (in .env)',
          accessToken: internalTokens?.userAccessToken
            ? maskToken(internalTokens.userAccessToken)
            : 'Not available',
          accessTokenExpiry: internalTokens?.userAccessTokenExpiry
            ? {
                timestamp: internalTokens.userAccessTokenExpiry,
                date: new Date(internalTokens.userAccessTokenExpiry).toISOString(),
                expired: Date.now() >= internalTokens.userAccessTokenExpiry,
              }
            : 'Not available',
          refreshTokenExpiry: internalTokens?.userRefreshTokenExpiry
            ? {
                timestamp: internalTokens.userRefreshTokenExpiry,
                date: new Date(internalTokens.userRefreshTokenExpiry).toISOString(),
                expired: Date.now() >= internalTokens.userRefreshTokenExpiry,
              }
            : 'Not available',
          appToken: appToken ? maskToken(appToken) : 'Not cached',
          appTokenExpiry: appTokenExpiry
            ? {
                timestamp: appTokenExpiry,
                date: new Date(appTokenExpiry).toISOString(),
                expired: Date.now() >= appTokenExpiry,
              }
            : 'Not available',
        },
        status: {
          hasUserToken: tokenInfo.hasUserToken,
          hasAppAccessToken: tokenInfo.hasAppAccessToken,
          authenticated: api.isAuthenticated(),
          currentTokenType: tokenInfo.hasUserToken
            ? 'user_token (10,000-50,000 req/day)'
            : tokenInfo.hasAppAccessToken
              ? 'app_access_token (1,000 req/day)'
              : 'none',
        },
        scopes: internalTokens?.scope ? internalTokens.scope.split(' ') : [],
      };
    }

    case 'ebay_exchange_authorization_code': {
      const code = args.code as string;

      if (!code) {
        throw new Error('Authorization code is required');
      }

      try {
        // URL-decode the code if it's URL-encoded (contains % characters)
        const decodedCode = code.includes('%') ? decodeURIComponent(code) : code;

        // Get the OAuth client
        const authClient = api.getAuthClient().getOAuthClient();

        // Exchange the authorization code for tokens
        const tokenData = await authClient.exchangeCodeForToken(decodedCode);

        return {
          success: true,
          message:
            'Authorization code successfully exchanged for tokens. Tokens have been stored and will be used for subsequent API requests.',
          tokenData: {
            accessToken: `${tokenData.access_token.substring(0, 20)}...${tokenData.access_token.slice(-10)}`,
            refreshToken: `${tokenData.refresh_token.substring(0, 20)}...${tokenData.refresh_token.slice(-10)}`,
            expiresIn: tokenData.expires_in,
            refreshTokenExpiresIn: tokenData.refresh_token_expires_in,
            tokenType: tokenData.token_type,
            scope: tokenData.scope,
          },
          note: 'The refresh token has been saved to your .env file for future use.',
        };
      } catch (error) {
        throw new Error(
          `Failed to exchange authorization code: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    case 'ebay_refresh_access_token': {
      const authClient = api.getAuthClient().getOAuthClient();

      // Check if user tokens are available
      if (!api.hasUserTokens()) {
        throw new Error(
          'No user tokens available. Please set user tokens first using ebay_set_user_tokens_with_expiry or add EBAY_USER_REFRESH_TOKEN to your .env file.'
        );
      }

      try {
        // Call the public refreshUserToken method
        await authClient.refreshUserToken();

        // Get updated token info
        const internalTokens = authClient.getUserTokens();

        return {
          success: true,
          message: 'Access token refreshed successfully',
          accessToken: internalTokens?.userAccessToken
            ? `${internalTokens.userAccessToken.substring(0, 6)}...${internalTokens.userAccessToken.substring(internalTokens.userAccessToken.length - 6)}`
            : 'Not available',
          accessTokenExpiry: internalTokens?.userAccessTokenExpiry
            ? {
                timestamp: internalTokens.userAccessTokenExpiry,
                date: new Date(internalTokens.userAccessTokenExpiry).toISOString(),
                expiresInSeconds: Math.floor(
                  (internalTokens.userAccessTokenExpiry - Date.now()) / 1000
                ),
              }
            : 'Not available',
          tokenInfo: api.getTokenInfo(),
        };
      } catch (error) {
        throw new Error(
          `Failed to refresh access token: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    // Account Management
    case 'ebay_get_custom_policies':
      return await api.account.getCustomPolicies(args.policyTypes as string);
    case 'ebay_get_fulfillment_policies':
      return await api.account.getFulfillmentPolicies(args.marketplaceId as string);
    case 'ebay_get_payment_policies':
      return await api.account.getPaymentPolicies(args.marketplaceId as string);
    case 'ebay_get_return_policies':
      return await api.account.getReturnPolicies(args.marketplaceId as string);

    // Fulfillment Policy CRUD
    case 'ebay_create_fulfillment_policy': {
      // Normalize handlingTime.unit to valid enum values (LLMs often send lowercase/plural)
      const policy = args.policy as Record<string, unknown>;
      if (policy?.handlingTime && typeof policy.handlingTime === 'object') {
        const ht = policy.handlingTime as Record<string, unknown>;
        if (typeof ht.unit === 'string') {
          ht.unit = normalizeTimeUnit(ht.unit);
        }
      }
      return await api.account.createFulfillmentPolicy(policy);
    }
    case 'ebay_get_fulfillment_policy':
      return await api.account.getFulfillmentPolicy(args.fulfillmentPolicyId as string);
    case 'ebay_get_fulfillment_policy_by_name':
      return await api.account.getFulfillmentPolicyByName(
        args.marketplaceId as string,
        args.name as string
      );
    case 'ebay_update_fulfillment_policy':
      return await api.account.updateFulfillmentPolicy(
        args.fulfillmentPolicyId as string,
        args.policy as Record<string, unknown>
      );
    case 'ebay_delete_fulfillment_policy':
      return await api.account.deleteFulfillmentPolicy(args.fulfillmentPolicyId as string);

    // Payment Policy CRUD
    case 'ebay_create_payment_policy':
      return await api.account.createPaymentPolicy(args.policy as Record<string, unknown>);
    case 'ebay_get_payment_policy':
      return await api.account.getPaymentPolicy(args.paymentPolicyId as string);
    case 'ebay_get_payment_policy_by_name':
      return await api.account.getPaymentPolicyByName(
        args.marketplaceId as string,
        args.name as string
      );
    case 'ebay_update_payment_policy':
      return await api.account.updatePaymentPolicy(
        args.paymentPolicyId as string,
        args.policy as Record<string, unknown>
      );
    case 'ebay_delete_payment_policy':
      return await api.account.deletePaymentPolicy(args.paymentPolicyId as string);

    // Return Policy CRUD
    case 'ebay_create_return_policy':
      return await api.account.createReturnPolicy(args.policy as Record<string, unknown>);
    case 'ebay_get_return_policy':
      return await api.account.getReturnPolicy(args.returnPolicyId as string);
    case 'ebay_get_return_policy_by_name':
      return await api.account.getReturnPolicyByName(
        args.marketplaceId as string,
        args.name as string
      );
    case 'ebay_update_return_policy':
      return await api.account.updateReturnPolicy(
        args.returnPolicyId as string,
        args.policy as Record<string, unknown>
      );
    case 'ebay_delete_return_policy':
      return await api.account.deleteReturnPolicy(args.returnPolicyId as string);

    // Custom Policy CRUD
    case 'ebay_create_custom_policy':
      return await api.account.createCustomPolicy(args.policy as Record<string, unknown>);
    case 'ebay_get_custom_policy':
      return await api.account.getCustomPolicy(args.customPolicyId as string);
    case 'ebay_update_custom_policy':
      return await api.account.updateCustomPolicy(
        args.customPolicyId as string,
        args.policy as Record<string, unknown>
      );
    case 'ebay_delete_custom_policy':
      return await api.account.deleteCustomPolicy(args.customPolicyId as string);

    // KYC, Payments, Programs, Sales Tax, Subscription
    case 'ebay_get_kyc':
      return await api.account.getKyc();
    case 'ebay_opt_in_to_payments_program':
      return await api.account.optInToPaymentsProgram(
        args.marketplaceId as string,
        args.paymentsProgramType as string
      );
    case 'ebay_get_payments_program_status':
      return await api.account.getPaymentsProgramStatus(
        args.marketplaceId as string,
        args.paymentsProgramType as string
      );
    case 'ebay_get_rate_tables':
      return await api.account.getRateTables();
    case 'ebay_create_or_replace_sales_tax':
      return await api.account.createOrReplaceSalesTax(
        args.countryCode as string,
        args.jurisdictionId as string,
        args.salesTaxBase as Record<string, unknown>
      );
    case 'ebay_bulk_create_or_replace_sales_tax':
      return await api.account.bulkCreateOrReplaceSalesTax(
        args.requests as {
          countryCode: string;
          jurisdictionId: string;
          salesTaxBase: Record<string, unknown>;
        }[]
      );
    case 'ebay_delete_sales_tax':
      return await api.account.deleteSalesTax(
        args.countryCode as string,
        args.jurisdictionId as string
      );
    case 'ebay_get_sales_tax':
      return await api.account.getSalesTax(
        args.countryCode as string,
        args.jurisdictionId as string
      );
    case 'ebay_get_sales_taxes':
      return await api.account.getSalesTaxes(args.countryCode as string);
    case 'ebay_get_subscription':
      return await api.account.getSubscription(args.limitType as string);
    case 'ebay_opt_in_to_program':
      return await api.account.optInToProgram(args.request as Record<string, unknown>);
    case 'ebay_opt_out_of_program':
      return await api.account.optOutOfProgram(args.request as Record<string, unknown>);
    case 'ebay_get_opted_in_programs':
      return await api.account.getOptedInPrograms();
    case 'ebay_get_privileges':
      return await api.account.getPrivileges();
    case 'ebay_get_advertising_eligibility':
      return await api.account.getAdvertisingEligibility(
        args.marketplaceId as string,
        args.programTypes as string | undefined
      );
    case 'ebay_get_payments_program':
      return await api.account.getPaymentsProgram(
        args.marketplaceId as string,
        args.paymentsProgramType as string
      );
    case 'ebay_get_payments_program_onboarding':
      return await api.account.getPaymentsProgramOnboarding(
        args.marketplaceId as string,
        args.paymentsProgramType as string
      );

    // Inventory Management
    case 'ebay_get_inventory_items':
      return await api.inventory.getInventoryItems(args.limit as number, args.offset as number);
    case 'ebay_get_inventory_item':
      return await api.inventory.getInventoryItem(args.sku as string);
    case 'ebay_create_inventory_item': {
      // Handle both patterns: nested inventoryItem OR flat fields
      let inventoryItemData = args.inventoryItem as Record<string, unknown> | undefined;
      if (!inventoryItemData || typeof inventoryItemData !== 'object') {
        // Merge fallback fields into inventoryItem
        const fallbackFields = [
          'availability',
          'condition',
          'conditionDescription',
          'product',
          'packageWeightAndSize',
        ];
        inventoryItemData = {};
        for (const field of fallbackFields) {
          if (args[field] !== undefined) {
            inventoryItemData[field] = args[field];
          }
        }
      }
      return await api.inventory.createOrReplaceInventoryItem(
        args.sku as string,
        inventoryItemData
      );
    }
    case 'ebay_delete_inventory_item':
      return await api.inventory.deleteInventoryItem(args.sku as string);

    case 'ebay_update_inventory_item': {
      const sku = args.sku as string;
      // Fetch existing item
      let existing: Record<string, unknown>;
      try {
        existing = await api.inventory.getInventoryItem(sku);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('not found') || msg.includes('404') || msg.includes('not exist')) {
          throw new Error(
            `Inventory item not found: ${sku}. Create it first with ebay_create_inventory_item.`,
            { cause: e }
          );
        }
        throw new Error(`Failed to fetch inventory item ${sku}: ${msg}`, { cause: e });
      }
      // Deep merge updates into existing
      const updateObj: Record<string, unknown> = {};
      if (args.availability) updateObj.availability = args.availability;
      if (args.product) updateObj.product = args.product;
      if (args.condition) updateObj.condition = args.condition;
      if (args.conditionDescription) updateObj.conditionDescription = args.conditionDescription;
      const merged = deepMerge(existing, updateObj);
      // Save back via createOrReplace
      await api.inventory.createOrReplaceInventoryItem(sku, merged);
      return { sku, status: 'updated' };
    }

    // Bulk Operations
    case 'ebay_bulk_create_or_replace_inventory_item':
      return await api.inventory.bulkCreateOrReplaceInventoryItem(
        args.requests as Record<string, unknown>
      );
    case 'ebay_bulk_get_inventory_item':
      return await api.inventory.bulkGetInventoryItem(args.requests as Record<string, unknown>);
    case 'ebay_bulk_update_price_quantity':
      return await api.inventory.bulkUpdatePriceQuantity(args.requests as Record<string, unknown>);

    // Product Compatibility
    case 'ebay_get_product_compatibility':
      return await api.inventory.getProductCompatibility(args.sku as string);
    case 'ebay_create_or_replace_product_compatibility':
      return await api.inventory.createOrReplaceProductCompatibility(
        args.sku as string,
        args.compatibility as Record<string, unknown>
      );
    case 'ebay_delete_product_compatibility':
      return await api.inventory.deleteProductCompatibility(args.sku as string);

    // Inventory Item Groups
    case 'ebay_get_inventory_item_group':
      return await api.inventory.getInventoryItemGroup(args.inventoryItemGroupKey as string);
    case 'ebay_create_or_replace_inventory_item_group':
      return await api.inventory.createOrReplaceInventoryItemGroup(
        args.inventoryItemGroupKey as string,
        args.inventoryItemGroup as Record<string, unknown>
      );
    case 'ebay_delete_inventory_item_group':
      return await api.inventory.deleteInventoryItemGroup(args.inventoryItemGroupKey as string);

    // Location Management
    case 'ebay_get_inventory_locations':
      return await api.inventory.getInventoryLocations(args.limit as number, args.offset as number);
    case 'ebay_get_inventory_location':
      return await api.inventory.getInventoryLocation(args.merchantLocationKey as string);
    case 'ebay_create_or_replace_inventory_location':
      return await api.inventory.createOrReplaceInventoryLocation(
        args.merchantLocationKey as string,
        args.location as Record<string, unknown>
      );
    case 'ebay_delete_inventory_location':
      return await api.inventory.deleteInventoryLocation(args.merchantLocationKey as string);
    case 'ebay_disable_inventory_location':
      return await api.inventory.disableInventoryLocation(args.merchantLocationKey as string);
    case 'ebay_enable_inventory_location':
      return await api.inventory.enableInventoryLocation(args.merchantLocationKey as string);
    case 'ebay_update_location_details':
      return await api.inventory.updateLocationDetails(
        args.merchantLocationKey as string,
        args.locationDetails as Record<string, unknown>
      );

    // Offer Management
    case 'ebay_get_offers':
      return await api.inventory.getOffers(
        args.sku as string,
        args.marketplaceId as string,
        args.limit as number
      );
    case 'ebay_get_offer':
      return await api.inventory.getOffer(args.offerId as string);
    case 'ebay_create_offer': {
      const offer = args.offer as Record<string, unknown>;
      if (offer?.format) {
        offer.format = normalizeEnumValue(offer.format as string);
      }
      return await api.inventory.createOffer(offer);
    }
    case 'ebay_update_offer': {
      const offer = args.offer as Record<string, unknown>;
      if (offer?.format) {
        offer.format = normalizeEnumValue(offer.format as string);
      }
      return await api.inventory.updateOffer(args.offerId as string, offer);
    }
    case 'ebay_delete_offer':
      return await api.inventory.deleteOffer(args.offerId as string);
    case 'ebay_publish_offer': {
      const offerId = args.offerId as string;
      // Pre-publish: ensure offer has categoryId + merchantLocationKey + listingPolicies,
      // and inventory item has brand/mpn pair + location mapping + itemSpecifics.
      try {
        const offer = await api.inventory.getOffer(offerId);
        const offerData = offer as Record<string, unknown>;
        const sku = offerData?.sku as string | undefined;
        if (sku) {
          // Default policy IDs (Hankuk Expo)
          const defaultPolicies = {
            paymentPolicyId: '259198675013',
            returnPolicyId: '259198703013',
            fulfillmentPolicyId: '259198453013',
          };
          // Fix offer-level fields first
          let needsOfferUpdate = false;
          const offerUpdate: Record<string, unknown> = {
            sku,
            marketplaceId: offerData.marketplaceId,
            format: offerData.format,
            availableQuantity: offerData.availableQuantity,
            pricingSummary: offerData.pricingSummary,
            listingPolicies: offerData.listingPolicies,
            tax: offerData.tax,
          };
          if (!offerData.categoryId) {
            offerUpdate.categoryId = '176984'; // Default: Music > CDs
            needsOfferUpdate = true;
          }
          if (!offerData.merchantLocationKey) {
            offerUpdate.merchantLocationKey = 'seoul-warehouse';
            needsOfferUpdate = true;
          }
          // Inject listingPolicies if missing
          const existingPolicies = offerData.listingPolicies as Record<string, unknown> | undefined;
          if (
            !existingPolicies?.paymentPolicyId ||
            !existingPolicies.returnPolicyId ||
            !existingPolicies.fulfillmentPolicyId
          ) {
            offerUpdate.listingPolicies = {
              ...defaultPolicies,
              ...(existingPolicies || {}),
            };
            needsOfferUpdate = true;
          }
          // Ensure pricingSummary has currency
          const pricingSummary = offerData.pricingSummary as Record<string, unknown> | undefined;
          if (pricingSummary?.price && typeof pricingSummary.price === 'object') {
            const priceObj = pricingSummary.price as Record<string, unknown>;
            if (!priceObj.currency) {
              priceObj.currency = 'USD';
              needsOfferUpdate = true;
            }
          }
          if (needsOfferUpdate) {
            await api.inventory.updateOffer(offerId, offerUpdate);
          }

          // Fix inventory item fields (brand/mpn pair + itemSpecifics)
          try {
            const items = await api.inventory.getInventoryItem(sku);
            const itemData = Array.isArray(items)
              ? (items as Record<string, unknown>[])?.[0]
              : items;
            const item = itemData as Record<string, unknown>;
            if (item) {
              const product = (item.product as Record<string, unknown>) || {};
              let needsInventoryUpdate = false;
              if (product.brand && !product.mpn) {
                product.mpn = sku;
                needsInventoryUpdate = true;
              }
              if (!product.brand && product.mpn) {
                product.brand = 'Unbranded';
                needsInventoryUpdate = true;
              }
              if (!item.merchantLocationKey) {
                item.merchantLocationKey = 'seoul-warehouse';
                needsInventoryUpdate = true;
              }
              if (needsInventoryUpdate) {
                item.product = product;
                await api.inventory.createOrReplaceInventoryItem(sku, item);
              }
            }
          } catch (e) {
            console.warn(`publish_offer inventory check warning for ${sku}: ${e}`);
          }
        }
      } catch (e) {
        console.warn(`publish_offer pre-transform warning for ${offerId}: ${e}`);
      }

      // Use Trading API to publish with proper XML transform (Currency, Country, itemSpecifics)
      try {
        const offer = await api.inventory.getOffer(offerId);
        const offerData = offer as Record<string, unknown>;
        const sku = offerData?.sku as string | undefined;

        if (sku) {
          const items = await api.inventory.getInventoryItem(sku);
          const itemData = Array.isArray(items) ? (items as Record<string, unknown>[])?.[0] : items;
          const inventoryItem = itemData as Record<string, unknown>;
          const product = (inventoryItem?.product as Record<string, unknown>) || {};

          // Get location for Country
          const locationKey = offerData.merchantLocationKey || 'seoul-warehouse';
          let country = 'KR';
          try {
            const location = await api.inventory.getInventoryLocation(locationKey as string);
            const locData = location as Record<string, unknown>;
            const address = locData?.address as Record<string, unknown> | undefined;
            if (address?.country) {
              country = address.country as string;
            }
          } catch {
            // Default to KR
          }

          // Build Trading API item object
          const pricingSummary = offerData.pricingSummary as Record<string, unknown> | undefined;
          const priceObj = pricingSummary?.price as Record<string, unknown> | undefined;
          const tradingItem: Record<string, unknown> = {
            SKU: sku,
            Title: product.title || offerData.title || sku,
            Description: product.description || offerData.listingDescription || '',
            PrimaryCategory: { CategoryID: offerData.categoryId || '176984' },
            StartPrice: priceObj?.value || '0',
            Currency: priceObj?.currency || 'USD',
            Quantity: offerData.availableQuantity || 1,
            ListingDuration: 'GTC',
            ListingType: 'FixedPriceItem',
            ConditionID: offerData.condition === 'NEW' ? 1000 : 3000,
            Country: country,
            PaymentMethods: ['PayPal'],
            DispatchTimeMax: 3,
            ShippingServiceOptions: {
              ShippingService: 'USPSGround',
              ShippingServiceCost: { Value: '0', CurrencyId: 'USD' },
            },
            ReturnPolicy: {
              ReturnsAcceptedOption: 'ReturnsAccepted',
              ReturnsWithinOption: 'Days_30',
              Description: 'Returns accepted within 30 days.',
              RefundOption: 'MoneyBack',
            },
          };

          // Add itemSpecifics from inventory item product aspects
          const aspects = product.aspects as Record<string, string[]> | undefined;
          if (aspects && Object.keys(aspects).length > 0) {
            tradingItem.ItemSpecifics = {
              NameValueList: Object.entries(aspects).map(([name, value]) => ({
                Name: name,
                Value: Array.isArray(value) ? value : [value],
              })),
            };
          }

          // Add pictures
          const imageUrls = product.imageUrls as string[] | undefined;
          if (imageUrls && imageUrls.length > 0) {
            tradingItem.PictureDetails = {
              PictureURL: imageUrls.length === 1 ? imageUrls[0] : imageUrls,
            };
          }

          // Publish via Trading API with transform
          return await api.trading.createListing(tradingItem);
        }
      } catch (e) {
        console.warn(`publish_offer Trading API warning for ${offerId}: ${e}`);
        // Fallback to Inventory API if Trading API fails
      }

      return await api.inventory.publishOffer(offerId);
    }
    case 'ebay_withdraw_offer':
      return await api.inventory.withdrawOffer(args.offerId as string);
    case 'ebay_bulk_create_offer':
      return await api.inventory.bulkCreateOffer(args.requests as Record<string, unknown>);
    case 'ebay_bulk_publish_offer':
      return await api.inventory.bulkPublishOffer(args.requests as Record<string, unknown>);
    case 'ebay_get_listing_fees':
      return await api.inventory.getListingFees(args.offers as Record<string, unknown>);

    // Listing Migration
    case 'ebay_bulk_migrate_listing':
      return await api.inventory.bulkMigrateListing(args.requests as Record<string, unknown>);

    case 'ebay_get_listing_locations':
      return await api.inventory.getListingLocations(args.listingId as string, args.sku as string);
    case 'ebay_create_or_replace_sku_location_mapping':
      return await api.inventory.createOrReplaceSkuLocationMapping(
        args.listingId as string,
        args.sku as string,
        args.locationMapping as Record<string, unknown>
      );
    case 'ebay_delete_sku_location_mapping':
      return await api.inventory.deleteSkuLocationMapping(
        args.listingId as string,
        args.sku as string
      );
    case 'ebay_publish_offer_by_inventory_item_group':
      return await api.inventory.publishOfferByInventoryItemGroup(
        args.request as Record<string, unknown>
      );
    case 'ebay_withdraw_offer_by_inventory_item_group':
      return await api.inventory.withdrawOfferByInventoryItemGroup(
        args.request as Record<string, unknown>
      );

    // Order Management
    case 'ebay_get_orders':
      return await api.fulfillment.getOrders(
        args.filter as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_get_order':
      return await api.fulfillment.getOrder(args.orderId as string);
    case 'ebay_create_shipping_fulfillment':
      return await api.fulfillment.createShippingFulfillment(
        args.orderId as string,
        args.fulfillment as Record<string, unknown>
      );
    case 'ebay_issue_refund':
      return await api.fulfillment.issueRefund(
        args.orderId as string,
        args.refundData as Record<string, unknown>
      );

    case 'ebay_get_shipping_fulfillments':
      return await api.fulfillment.getShippingFulfillments(args.orderId as string);
    case 'ebay_get_shipping_fulfillment':
      return await api.fulfillment.getShippingFulfillment(
        args.orderId as string,
        args.fulfillmentId as string
      );
    case 'ebay_get_payment_dispute_summaries':
      return await api.dispute.getPaymentDisputeSummaries({
        order_id: args.orderFilter as string | undefined,
        buyer_username: args.buyerFilter as string | undefined,
        payment_dispute_status: args.openFilter ? 'OPEN' : undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
    case 'ebay_get_payment_dispute':
      return await api.dispute.getPaymentDispute(args.paymentDisputeId as string);
    case 'ebay_get_payment_dispute_activities':
      return await api.dispute.getActivities(args.paymentDisputeId as string);
    case 'ebay_accept_payment_dispute':
      return await api.dispute.acceptPaymentDispute(
        args.paymentDisputeId as string,
        args.returnAddress as Record<string, unknown> | undefined
      );
    case 'ebay_contest_payment_dispute':
      return await api.dispute.contestPaymentDispute(
        args.paymentDisputeId as string,
        args.returnAddress as Record<string, unknown> | undefined
      );
    case 'ebay_add_payment_dispute_evidence':
      return await api.dispute.addEvidence(args.paymentDisputeId as string, args);
    case 'ebay_update_payment_dispute_evidence':
      return await api.dispute.updateEvidence(args.paymentDisputeId as string, args);
    case 'ebay_upload_payment_dispute_evidence_file':
      return await api.dispute.uploadEvidenceFile(
        args.paymentDisputeId as string,
        args.file as ArrayBuffer
      );
    case 'ebay_fetch_payment_dispute_evidence_content':
      return await api.dispute.fetchEvidenceContent(
        args.paymentDisputeId as string,
        args.evidenceId as string,
        args.fileId as string
      );

    // Marketing - Campaign Management
    case 'ebay_get_campaigns':
      return await api.marketing.getCampaigns(
        args.campaignStatus as string,
        args.marketplaceId as string,
        args.limit as number
      );
    case 'ebay_get_campaign':
      return await api.marketing.getCampaign(args.campaignId as string);
    case 'ebay_get_campaign_by_name':
      return await api.marketing.getCampaignByName(args.campaignName as string);
    case 'ebay_create_campaign':
      return await api.marketing.createCampaign(args.campaign as Record<string, unknown>);
    case 'ebay_clone_campaign':
      return await api.marketing.cloneCampaign(
        args.campaignId as string,
        args.cloneData as Record<string, unknown>
      );
    case 'ebay_pause_campaign':
      return await api.marketing.pauseCampaign(args.campaignId as string);
    case 'ebay_resume_campaign':
      return await api.marketing.resumeCampaign(args.campaignId as string);
    case 'ebay_end_campaign':
      return await api.marketing.endCampaign(args.campaignId as string);
    case 'ebay_update_campaign_identification':
      return await api.marketing.updateCampaignIdentification(
        args.campaignId as string,
        args.updateData as Record<string, unknown>
      );

    // Marketing - Ad Operations (Bulk)
    case 'ebay_bulk_create_ads_by_inventory_reference':
      return await api.marketing.bulkCreateAdsByInventoryReference(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_bulk_create_ads_by_listing_id':
      return await api.marketing.bulkCreateAdsByListingId(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_bulk_delete_ads_by_inventory_reference':
      return await api.marketing.bulkDeleteAdsByInventoryReference(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_delete_ads_by_inventory_reference':
      return await api.marketing.deleteAdsByInventoryReference(args.campaignId as string, {
        inventoryReferenceId: args.inventoryReferenceId,
        inventoryReferenceType: args.inventoryReferenceType,
      });
    case 'ebay_bulk_delete_ads_by_listing_id':
      return await api.marketing.bulkDeleteAdsByListingId(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_bulk_update_ads_bid_by_inventory_reference':
      return await api.marketing.bulkUpdateAdsBidByInventoryReference(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_bulk_update_ads_bid_by_listing_id':
      return await api.marketing.bulkUpdateAdsBidByListingId(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_bulk_update_ads_status':
      return await api.marketing.bulkUpdateAdsStatus(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_bulk_update_ads_status_by_listing_id':
      return await api.marketing.bulkUpdateAdsStatusByListingId(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );

    // Marketing - Ad Operations (Single)
    case 'ebay_create_ad':
      return await api.marketing.createAd(
        args.campaignId as string,
        args.ad as Record<string, unknown>
      );
    case 'ebay_create_ads_by_inventory_reference':
      return await api.marketing.createAdsByInventoryReference(
        args.campaignId as string,
        args.ads as Record<string, unknown>
      );
    case 'ebay_get_ad':
      return await api.marketing.getAd(args.campaignId as string, args.adId as string);
    case 'ebay_get_ads':
      return await api.marketing.getAds(
        args.campaignId as string,
        args.adGroupIds as string,
        args.adStatus as string,
        args.limit as number,
        args.listingIds as string,
        args.offset as number
      );
    case 'ebay_get_ads_by_inventory_reference':
      return await api.marketing.getAdsByInventoryReference(
        args.campaignId as string,
        args.inventoryReferenceId as string,
        args.inventoryReferenceType as string
      );
    case 'ebay_get_ads_by_listing_id':
      return await api.marketing.getAdsByListingId(
        args.campaignId as string,
        args.listingId as string
      );
    case 'ebay_delete_ad':
      return await api.marketing.deleteAd(args.campaignId as string, args.adId as string);
    case 'ebay_clone_ad':
      return await api.marketing.cloneAd(
        args.campaignId as string,
        args.adId as string,
        args.ad as Record<string, unknown>
      );
    case 'ebay_update_ad_bid':
      return await api.marketing.updateBid(
        args.campaignId as string,
        args.adId as string,
        args.bidData as Record<string, unknown>
      );

    // Marketing - Ad Group Management
    case 'ebay_create_ad_group':
      return await api.marketing.createAdGroup(
        args.campaignId as string,
        args.adGroup as Record<string, unknown>
      );
    case 'ebay_get_ad_group':
      return await api.marketing.getAdGroup(args.campaignId as string, args.adGroupId as string);
    case 'ebay_get_ad_groups':
      return await api.marketing.getAdGroups(
        args.campaignId as string,
        args.adGroupStatus as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_clone_ad_group':
      return await api.marketing.cloneAdGroup(
        args.campaignId as string,
        args.adGroupId as string,
        args.adGroup as Record<string, unknown>
      );
    case 'ebay_update_ad_group_bids':
      return await api.marketing.updateAdGroupBids(
        args.campaignId as string,
        args.adGroupId as string,
        args.bidsData as Record<string, unknown>
      );
    case 'ebay_update_ad_group_keywords':
      return await api.marketing.updateAdGroupKeywords(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywordsData as Record<string, unknown>
      );

    // Marketing - Keyword Management
    case 'ebay_create_keyword':
      return await api.marketing.createKeyword(
        args.campaignId as string,
        args.adGroupId as string,
        args.keyword as Record<string, unknown>
      );
    case 'ebay_get_keyword':
      return await api.marketing.getKeyword(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywordId as string
      );
    case 'ebay_get_keywords':
      return await api.marketing.getKeywords(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywordStatus as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_delete_keyword':
      return await api.marketing.deleteKeyword(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywordId as string
      );
    case 'ebay_update_keyword_bid':
      return await api.marketing.updateKeywordBid(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywordId as string,
        args.bidData as Record<string, unknown>
      );
    case 'ebay_bulk_create_keywords':
      return await api.marketing.bulkCreateKeywords(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywords as Record<string, unknown>
      );
    case 'ebay_bulk_delete_keywords':
      return await api.marketing.bulkDeleteKeywords(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywords as Record<string, unknown>
      );
    case 'ebay_bulk_update_keyword_bids':
      return await api.marketing.bulkUpdateKeywordBids(
        args.campaignId as string,
        args.adGroupId as string,
        args.keywords as Record<string, unknown>
      );

    // Marketing - Negative Keywords (Campaign Level)
    case 'ebay_create_negative_keyword':
      return await api.marketing.createNegativeKeyword(
        args.campaignId as string,
        args.negativeKeyword as Record<string, unknown>
      );
    case 'ebay_get_negative_keyword':
      return await api.marketing.getNegativeKeyword(
        args.campaignId as string,
        args.negativeKeywordId as string
      );
    case 'ebay_get_negative_keywords':
      return await api.marketing.getNegativeKeywords(
        args.campaignId as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_delete_negative_keyword':
      return await api.marketing.deleteNegativeKeyword(
        args.campaignId as string,
        args.negativeKeywordId as string
      );
    case 'ebay_update_negative_keyword':
      return await api.marketing.updateNegativeKeyword(
        args.campaignId as string,
        args.negativeKeywordId as string,
        args.negativeKeyword as Record<string, unknown>
      );
    case 'ebay_bulk_create_negative_keywords':
      return await api.marketing.bulkCreateNegativeKeywords(
        args.campaignId as string,
        args.negativeKeywords as Record<string, unknown>
      );
    case 'ebay_bulk_update_negative_keywords':
      return await api.marketing.bulkUpdateNegativeKeywords(
        args.campaignId as string,
        args.negativeKeywords as Record<string, unknown>
      );
    case 'ebay_bulk_delete_negative_keywords':
      return await api.marketing.bulkDeleteNegativeKeywords(
        args.campaignId as string,
        args.negativeKeywords as Record<string, unknown>
      );

    // Marketing - Negative Keywords (Ad Group Level)
    case 'ebay_create_negative_keyword_for_ad_group':
      return await api.marketing.createNegativeKeywordForAdGroup(
        args.adGroupId as string,
        args.negativeKeyword as Record<string, unknown>
      );
    case 'ebay_get_negative_keyword_for_ad_group':
      return await api.marketing.getNegativeKeywordForAdGroup(
        args.adGroupId as string,
        args.negativeKeywordId as string
      );
    case 'ebay_get_negative_keywords_for_ad_group':
      return await api.marketing.getNegativeKeywordsForAdGroup(
        args.adGroupId as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_delete_negative_keyword_for_ad_group':
      return await api.marketing.deleteNegativeKeywordForAdGroup(
        args.adGroupId as string,
        args.negativeKeywordId as string
      );
    case 'ebay_update_negative_keyword_for_ad_group':
      return await api.marketing.updateNegativeKeywordForAdGroup(
        args.adGroupId as string,
        args.negativeKeywordId as string,
        args.negativeKeyword as Record<string, unknown>
      );
    case 'ebay_bulk_create_negative_keywords_for_ad_group':
      return await api.marketing.bulkCreateNegativeKeywordsForAdGroup(
        args.adGroupId as string,
        args.negativeKeywords as Record<string, unknown>
      );
    case 'ebay_bulk_update_negative_keywords_for_ad_group':
      return await api.marketing.bulkUpdateNegativeKeywordsForAdGroup(
        args.adGroupId as string,
        args.negativeKeywords as Record<string, unknown>
      );
    case 'ebay_bulk_delete_negative_keywords_for_ad_group':
      return await api.marketing.bulkDeleteNegativeKeywordsForAdGroup(
        args.adGroupId as string,
        args.negativeKeywords as Record<string, unknown>
      );

    // Marketing - Targeting
    case 'ebay_create_targeting':
      return await api.marketing.createTargeting(
        args.campaignId as string,
        args.targeting as Record<string, unknown>
      );
    case 'ebay_get_targeting':
      return await api.marketing.getTargeting(args.campaignId as string);
    case 'ebay_update_targeting':
      return await api.marketing.updateTargeting(
        args.campaignId as string,
        args.targeting as Record<string, unknown>
      );

    // Marketing - Suggestions
    case 'ebay_suggest_bids':
      return await api.marketing.suggestBids(args.campaignId as string, args.adGroupId as string);
    case 'ebay_suggest_keywords':
      return await api.marketing.suggestKeywords(
        args.campaignId as string,
        args.adGroupId as string,
        args.suggestion as Record<string, unknown>
      );

    // Marketing - Reporting
    case 'ebay_create_report_task':
      return await api.marketing.createReportTask(args.reportTask as Record<string, unknown>);
    case 'ebay_get_report_task':
      return await api.marketing.getReportTask(args.reportTaskId as string);
    case 'ebay_get_report_tasks':
      return await api.marketing.getReportTasks(
        args.reportTaskStatuses as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_get_ad_report':
      return await api.marketing.getAdReport(
        args.dimension as string,
        args.metric as string,
        args.reportStartDate as string,
        args.reportEndDate as string,
        args.sort as string,
        args.listingIds as string,
        args.marketplaceId as string
      );
    case 'ebay_get_ad_report_metadata':
      return await api.marketing.getAdReportMetadata();
    case 'ebay_get_ad_report_metadata_for_report_type':
      return await api.marketing.getAdReportMetadataForReportType(args.reportType as string);

    // Marketing - Promotions (Item Promotion)
    case 'ebay_get_promotions':
      return await api.marketing.getPromotions(args.marketplaceId as string, args.limit as number);
    case 'ebay_get_item_promotion':
      return await api.marketing.getItemPromotion(args.promotionId as string);
    case 'ebay_create_item_promotion':
      return await api.marketing.createPromotion(args.promotion as Record<string, unknown>);
    case 'ebay_update_item_promotion':
      return await api.marketing.updateItemPromotion(
        args.promotionId as string,
        args.promotion as Record<string, unknown>
      );
    case 'ebay_delete_item_promotion':
      return await api.marketing.deleteItemPromotion(args.promotionId as string);
    case 'ebay_pause_item_promotion':
      return await api.marketing.pauseItemPromotion(args.promotionId as string);
    case 'ebay_resume_item_promotion':
      return await api.marketing.resumeItemPromotion(args.promotionId as string);
    case 'ebay_get_promotion_report':
      return await api.marketing.getPromotionReport(
        args.marketplaceId as string,
        args.promotionStatus as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_get_promotion_summary_report':
      return await api.marketing.getPromotionSummaryReport(args.marketplaceId as string);

    case 'ebay_delete_campaign':
      return await api.marketing.deleteCampaign(args.campaignId as string);
    case 'ebay_launch_campaign':
      return await api.marketing.launchCampaign(args.campaignId as string);
    case 'ebay_find_campaign_by_ad_reference':
      return await api.marketing.findCampaignByAdReference(
        args.inventoryReferenceId as string | undefined,
        args.inventoryReferenceType as string | undefined,
        args.listingId as string | undefined
      );
    case 'ebay_setup_quick_campaign':
      return await api.marketing.setupQuickCampaign(args.quickCampaign as Record<string, unknown>);
    case 'ebay_suggest_budget':
      return await api.marketing.suggestBudget(args.campaignId as string | undefined);
    case 'ebay_suggest_items':
      return await api.marketing.suggestItems(args.campaignId as string);
    case 'ebay_suggest_max_cpc':
      return await api.marketing.suggestMaxCpc(args.suggestionRequest as Record<string, unknown>);
    case 'ebay_update_ad_rate_strategy':
      return await api.marketing.updateAdRateStrategy(
        args.campaignId as string,
        args.strategy as Record<string, unknown>
      );
    case 'ebay_update_bidding_strategy':
      return await api.marketing.updateBiddingStrategy(
        args.campaignId as string,
        args.strategy as Record<string, unknown>
      );
    case 'ebay_update_campaign_budget':
      return await api.marketing.updateCampaignBudget(
        args.campaignId as string,
        args.budget as Record<string, unknown>
      );
    case 'ebay_update_ad_group':
      return await api.marketing.updateAdGroup(
        args.campaignId as string,
        args.adGroupId as string,
        args.updateData as Record<string, unknown>
      );
    case 'ebay_update_keyword':
      return await api.marketing.updateKeyword(
        args.campaignId as string,
        args.keywordId as string,
        args.updateData as Record<string, unknown>
      );
    case 'ebay_bulk_create_campaign_keyword':
      return await api.marketing.bulkCreateKeyword(
        args.campaignId as string,
        args.keywords as Record<string, unknown>
      );
    case 'ebay_bulk_update_campaign_keyword':
      return await api.marketing.bulkUpdateKeyword(
        args.campaignId as string,
        args.keywords as Record<string, unknown>
      );
    case 'ebay_get_report':
      return await api.marketing.getReport(args.reportId as string);
    case 'ebay_delete_report_task':
      return await api.marketing.deleteReportTask(args.reportTaskId as string);
    case 'ebay_create_item_price_markdown_promotion':
      return await api.marketing.createItemPriceMarkdownPromotion(
        args.promotion as Record<string, unknown>
      );
    case 'ebay_get_item_price_markdown_promotion':
      return await api.marketing.getItemPriceMarkdownPromotion(args.promotionId as string);
    case 'ebay_update_item_price_markdown_promotion':
      return await api.marketing.updateItemPriceMarkdownPromotion(
        args.promotionId as string,
        args.promotion as Record<string, unknown>
      );
    case 'ebay_delete_item_price_markdown_promotion':
      return await api.marketing.deleteItemPriceMarkdownPromotion(args.promotionId as string);
    case 'ebay_get_listing_set':
      return await api.marketing.getListingSet(args.promotionId as string);
    case 'ebay_pause_promotion':
      return await api.marketing.pausePromotion(args.promotionId as string);
    case 'ebay_resume_promotion':
      return await api.marketing.resumePromotion(args.promotionId as string);
    case 'ebay_get_email_campaigns':
      return await api.marketing.getEmailCampaigns(
        args.limit as number | undefined,
        args.offset as number | undefined
      );
    case 'ebay_create_email_campaign':
      return await api.marketing.createEmailCampaign(args.emailCampaign as Record<string, unknown>);
    case 'ebay_get_email_campaign':
      return await api.marketing.getEmailCampaign(args.emailCampaignId as string);
    case 'ebay_update_email_campaign':
      return await api.marketing.updateEmailCampaign(
        args.emailCampaignId as string,
        args.emailCampaign as Record<string, unknown>
      );
    case 'ebay_delete_email_campaign':
      return await api.marketing.deleteEmailCampaign(args.emailCampaignId as string);
    case 'ebay_get_email_audiences':
      return await api.marketing.getAudiences();
    case 'ebay_get_email_preview':
      return await api.marketing.getEmailPreview(args.emailCampaignId as string);
    case 'ebay_get_email_report':
      return await api.marketing.getEmailReport(
        args.limit as number | undefined,
        args.offset as number | undefined
      );

    // Recommendation
    case 'ebay_find_listing_recommendations':
      return await api.recommendation.findListingRecommendations(
        args.listingIds ? { listingIds: args.listingIds as string[] } : undefined,
        args.filter as string,
        args.limit as number,
        args.offset as number,
        args.marketplaceId as string
      );

    // Analytics
    case 'ebay_get_traffic_report':
      return await api.analytics.getTrafficReport(
        args.dimension as string,
        args.filter as string,
        args.metric as string,
        args.sort as string
      );
    case 'ebay_find_seller_standards_profiles':
      return await api.analytics.findSellerStandardsProfiles();
    case 'ebay_get_seller_standards_profile':
      return await api.analytics.getSellerStandardsProfile(
        args.program as string,
        args.cycle as string
      );
    case 'ebay_get_customer_service_metric':
      return await api.analytics.getCustomerServiceMetric(
        args.customerServiceMetricType as string,
        args.evaluationType as string,
        args.evaluationMarketplaceId as string
      );

    // Metadata
    case 'ebay_get_automotive_parts_compatibility_policies':
      return await api.metadata.getAutomotivePartsCompatibilityPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_category_policies':
      return await api.metadata.getCategoryPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_extended_producer_responsibility_policies':
      return await api.metadata.getExtendedProducerResponsibilityPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_hazardous_materials_labels':
      return await api.metadata.getHazardousMaterialsLabels(args.marketplaceId as string);
    case 'ebay_get_item_condition_policies':
      return await api.metadata.getItemConditionPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_listing_structure_policies':
      return await api.metadata.getListingStructurePolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_negotiated_price_policies':
      return await api.metadata.getNegotiatedPricePolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_product_safety_labels':
      return await api.metadata.getProductSafetyLabels(args.marketplaceId as string);
    case 'ebay_get_regulatory_policies':
      return await api.metadata.getRegulatoryPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_return_policy_metadata':
      return await api.metadata.getReturnPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_shipping_cost_type_policies':
      return await api.metadata.getShippingCostTypePolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_classified_ad_policies':
      return await api.metadata.getClassifiedAdPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_currencies':
      return await api.metadata.getCurrencies(args.marketplaceId as string);
    case 'ebay_get_listing_type_policies':
      return await api.metadata.getListingTypePolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_motors_listing_policies':
      return await api.metadata.getMotorsListingPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_shipping_policies':
      return await api.metadata.getShippingPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_site_visibility_policies':
      return await api.metadata.getSiteVisibilityPolicies(
        args.marketplaceId as string,
        args.filter as string
      );
    case 'ebay_get_compatibilities_by_specification':
      return await api.metadata.getCompatibilitiesBySpecification(
        args.specification as Record<string, unknown>
      );
    case 'ebay_get_compatibility_property_names':
      return await api.metadata.getCompatibilityPropertyNames(args.data as Record<string, unknown>);
    case 'ebay_get_compatibility_property_values':
      return await api.metadata.getCompatibilityPropertyValues(
        args.data as Record<string, unknown>
      );
    case 'ebay_get_multi_compatibility_property_values':
      return await api.metadata.getMultiCompatibilityPropertyValues(
        args.data as Record<string, unknown>
      );
    case 'ebay_get_product_compatibilities':
      return await api.metadata.getProductCompatibilities(args.data as Record<string, unknown>);
    case 'ebay_get_sales_tax_jurisdictions':
      return await api.metadata.getSalesTaxJurisdictions(args.countryCode as string);

    // Taxonomy
    case 'ebay_get_default_category_tree_id':
      return await api.taxonomy.getDefaultCategoryTreeId(args.marketplaceId as string);
    case 'ebay_get_category_tree':
      return await api.taxonomy.getCategoryTree(args.categoryTreeId as string);
    case 'ebay_get_category_suggestions':
      return await api.taxonomy.getCategorySuggestions(
        args.categoryTreeId as string,
        args.query as string
      );
    case 'ebay_get_item_aspects_for_category':
      return await api.taxonomy.getItemAspectsForCategory(
        args.categoryTreeId as string,
        args.categoryId as string
      );
    case 'ebay_get_category':
      return await api.taxonomy.getCategorySubtree(
        args.categoryTreeId as string,
        args.categoryId as string
      );

    // Browse API Tools
    case 'ebay_get_suggestions': {
      const query = args.query as string;
      const marketplaceId = (args.marketplaceId as string) || 'EBAY_US';
      const limit = args.limit as number | undefined;
      return await api.browse.getSuggestions(query, { marketplaceId, limit });
    }
    case 'ebay_search_products': {
      const query = args.query as string;
      const marketplaceId = args.marketplaceId as string;
      const categoryId = args.categoryId as string | undefined;
      const limit = args.limit as number | undefined;
      const sort = args.sort as string | undefined;
      const filter = args.filter as string | undefined;
      return await api.browse.searchProducts(query, {
        marketplaceId,
        categoryId,
        limit,
        sort,
        filter,
      });
    }
    case 'ebay_get_item_specifics': {
      const categoryTreeId = args.categoryTreeId as string;
      const categoryId = args.categoryId as string;
      return await api.taxonomy.getItemAspectsForCategory(categoryTreeId, categoryId);
    }

    // Communication - Negotiation
    case 'ebay_get_offers_to_buyers': {
      const validated = getOffersToBuyersSchema.parse(args);
      return await api.negotiation.getOffersToBuyers(
        validated.filter,
        validated.limit ? Number(validated.limit) : undefined,
        validated.offset ? Number(validated.offset) : undefined
      );
    }
    case 'ebay_send_offer_to_interested_buyers': {
      const validated = sendOfferToInterestedBuyersSchema.parse(args);
      return await api.negotiation.sendOfferToInterestedBuyers(validated);
    }
    case 'ebay_find_eligible_items': {
      const validated = findEligibleItemsSchema.parse(args);
      return await api.negotiation.findEligibleItems(
        validated.marketplace_id,
        validated.limit ? Number(validated.limit) : undefined,
        validated.offset ? Number(validated.offset) : undefined
      );
    }

    // Communication - Message
    case 'ebay_search_messages': {
      const validated = getConversationsSchema.parse(args);
      return await api.message.searchMessages(
        undefined,
        validated.limit ? Number(validated.limit) : undefined,
        validated.offset ? Number(validated.offset) : undefined
      );
    }
    case 'ebay_get_message': {
      const validated = getConversationSchema.parse(args);
      return await api.message.getMessage(validated.conversation_id);
    }
    case 'ebay_send_message': {
      const validated = sendMessageSchema.parse(args);
      return await api.message.sendMessage(validated);
    }
    case 'ebay_reply_to_message': {
      // This is a deprecated method that maps to sendMessage
      // We'll validate with a simple schema
      if (!args.messageId || !args.messageContent) {
        throw new Error('messageId and messageContent are required');
      }
      return await api.message.replyToMessage(
        args.messageId as string,
        args.messageContent as string
      );
    }
    case 'ebay_get_conversations': {
      const validated = getConversationsSchema.parse(args);
      return await api.message.getConversations(
        undefined,
        validated.limit ? Number(validated.limit) : undefined,
        validated.offset ? Number(validated.offset) : undefined
      );
    }
    case 'ebay_get_conversation': {
      const validated = getConversationSchema.parse(args);
      return await api.message.getConversation(validated.conversation_id);
    }
    case 'ebay_bulk_update_conversation': {
      const validated = bulkUpdateConversationSchema.parse(args);
      return await api.message.bulkUpdateConversation(validated);
    }
    case 'ebay_update_conversation': {
      const validated = updateConversationSchema.parse(args);
      return await api.message.updateConversation(validated);
    }

    // Communication - Notification
    case 'ebay_get_notification_config': {
      getConfigSchema.parse(args); // Validate empty args
      return await api.notification.getConfig();
    }
    case 'ebay_update_notification_config': {
      const validated = updateConfigSchema.parse(args);
      return await api.notification.updateConfig(validated);
    }
    case 'ebay_get_notification_destinations':
      return await api.notification.getDestinations(
        args.limit as number | undefined,
        args.continuationToken as string | undefined
      );
    case 'ebay_create_notification_destination': {
      // The MCP tool definition wraps inputs inside a `destination` field:
      // { destination: { name, endpoint, verificationToken } }
      // eBay API expects: { name, status, deliveryConfig: { endpoint, verificationToken } }
      const dest = args.destination as Record<string, unknown> | undefined;
      if (dest) {
        const { name, endpoint, verificationToken, status } = dest as {
          name?: string;
          endpoint?: string;
          verificationToken?: string;
          status?: string;
        };
        const ebayPayload: Record<string, unknown> = {
          name,
          status: status ?? 'ENABLED',
          deliveryConfig: { endpoint, verificationToken },
        };
        return await api.notification.createDestination(ebayPayload);
      } else {
        // Fallback: legacy flat delivery_config format
        const validated = createDestinationSchema.parse(args);
        const { delivery_config, name, status } = validated;
        const ebayPayload: Record<string, unknown> = {
          name,
          status: status ?? 'ENABLED',
          deliveryConfig: {
            endpoint: delivery_config?.endpoint,
            verificationToken: delivery_config?.verification_token,
          },
        };
        return await api.notification.createDestination(ebayPayload);
      }
    }
    case 'ebay_get_notification_destination': {
      const validated = getDestinationSchema.parse(args);
      return await api.notification.getDestination(validated.destination_id);
    }
    case 'ebay_update_notification_destination': {
      const validated = updateDestinationSchema.parse(args);
      return await api.notification.updateDestination(validated.destination_id, validated);
    }
    case 'ebay_delete_notification_destination': {
      const validated = deleteDestinationSchema.parse(args);
      return await api.notification.deleteDestination(validated.destination_id);
    }
    case 'ebay_get_notification_subscriptions': {
      const validated = getSubscriptionsSchema.parse(args);
      return await api.notification.getSubscriptions(
        validated.limit ? Number(validated.limit) : undefined,
        validated.continuation_token
      );
    }
    case 'ebay_create_notification_subscription': {
      const validated = createSubscriptionSchema.parse(args);
      // Convert snake_case to camelCase for eBay API
      const subPayload: Record<string, unknown> = {};
      if (validated.destination_id !== undefined)
        subPayload.destinationId = validated.destination_id;
      if (validated.status !== undefined) subPayload.status = validated.status;
      if (validated.topic_id !== undefined) subPayload.topicId = validated.topic_id;
      if (validated.payload !== undefined) {
        const p = validated.payload as Record<string, unknown>;
        subPayload.payload = {
          ...(p.delivery_protocol !== undefined && { deliveryProtocol: p.delivery_protocol }),
          ...(p.format !== undefined && { format: p.format }),
          ...(p.schema_version !== undefined && { schemaVersion: p.schema_version }),
        };
      }
      return await api.notification.createSubscription(subPayload);
    }
    case 'ebay_get_notification_subscription': {
      const validated = getSubscriptionSchema.parse(args);
      return await api.notification.getSubscription(validated.subscription_id);
    }
    case 'ebay_update_notification_subscription': {
      const validated = updateSubscriptionSchema.parse(args);
      return await api.notification.updateSubscription(validated.subscription_id, validated);
    }
    case 'ebay_delete_notification_subscription': {
      const validated = deleteSubscriptionSchema.parse(args);
      return await api.notification.deleteSubscription(validated.subscription_id);
    }
    case 'ebay_disable_notification_subscription': {
      const validated = disableSubscriptionSchema.parse(args);
      return await api.notification.disableSubscription(validated.subscription_id);
    }
    case 'ebay_enable_notification_subscription': {
      const validated = enableSubscriptionSchema.parse(args);
      return await api.notification.enableSubscription(validated.subscription_id);
    }
    case 'ebay_test_notification_subscription': {
      const validated = testSubscriptionSchema.parse(args);
      return await api.notification.testSubscription(validated.subscription_id);
    }
    case 'ebay_get_notification_topic': {
      const validated = getTopicSchema.parse(args);
      return await api.notification.getTopic(validated.topic_id);
    }
    case 'ebay_get_notification_topics': {
      const validated = getTopicsSchema.parse(args);
      return await api.notification.getTopics(
        validated.limit ? Number(validated.limit) : undefined,
        validated.continuation_token
      );
    }
    case 'ebay_create_notification_subscription_filter': {
      const validated = createSubscriptionFilterSchema.parse(args);
      return await api.notification.createSubscriptionFilter(validated.subscription_id, validated);
    }
    case 'ebay_get_notification_subscription_filter': {
      const validated = getSubscriptionFilterSchema.parse(args);
      return await api.notification.getSubscriptionFilter(
        validated.subscription_id,
        validated.filter_id
      );
    }
    case 'ebay_delete_notification_subscription_filter': {
      const validated = deleteSubscriptionFilterSchema.parse(args);
      return await api.notification.deleteSubscriptionFilter(
        validated.subscription_id,
        validated.filter_id
      );
    }
    case 'ebay_get_notification_public_key': {
      const validated = getPublicKeySchema.parse(args);
      return await api.notification.getPublicKey(validated.public_key_id);
    }

    // Communication - Feedback
    case 'ebay_get_feedback': {
      const validated = getFeedbackSchema.parse(args);
      return await api.feedback.getFeedback(validated.transaction_id ?? '');
    }
    case 'ebay_leave_feedback_for_buyer': {
      const validated = leaveFeedbackForBuyerSchema.parse(args);
      return await api.feedback.leaveFeedbackForBuyer(validated);
    }
    case 'ebay_get_feedback_summary': {
      getFeedbackRatingSummarySchema.parse(args); // Validate empty args
      return await api.feedback.getFeedbackSummary();
    }
    case 'ebay_get_awaiting_feedback': {
      const validated = getAwaitingFeedbackSchema.parse(args);
      return await api.feedback.getAwaitingFeedback(
        validated.filter,
        validated.limit ? Number(validated.limit) : undefined,
        validated.offset ? Number(validated.offset) : undefined
      );
    }
    case 'ebay_respond_to_feedback': {
      const validated = respondToFeedbackSchema.parse(args);
      return await api.feedback.respondToFeedback(
        validated.feedback_id ?? '',
        validated.response_text ?? ''
      );
    }

    // Other APIs - Identity
    case 'ebay_get_user':
      return await api.identity.getUser();

    // Other APIs - Compliance
    case 'ebay_get_listing_violations':
      return await api.compliance.getListingViolations(
        args.complianceType as string,
        args.offset as number,
        args.limit as number
      );
    case 'ebay_get_listing_violations_summary':
      return await api.compliance.getListingViolationsSummary(args.complianceType as string);
    case 'ebay_suppress_violation':
      return await api.compliance.suppressViolation(args.listingViolationId as string);

    // Other APIs - VERO
    case 'ebay_create_vero_report':
      return await api.vero.createVeroReport(args.reportData as Record<string, unknown>);
    case 'ebay_get_vero_report':
      return await api.vero.getVeroReport(args.veroReportId as string);
    case 'ebay_get_vero_report_items':
      return await api.vero.getVeroReportItems(
        args.filter as string,
        args.limit as number,
        args.offset as number
      );
    case 'ebay_get_vero_reason_code':
      return await api.vero.getVeroReasonCode(args.veroReasonCodeId as string);
    case 'ebay_get_vero_reason_codes':
      return await api.vero.getVeroReasonCodes();

    // Other APIs - Translation
    case 'ebay_translate':
      return await api.translation.translate(
        args.from as string,
        args.to as string,
        args.translationContext as string,
        args.text as string[]
      );

    // Other APIs - eDelivery
    case 'ebay_create_shipping_quote':
      return await api.edelivery.createShippingQuote(
        args.shippingQuoteRequest as Record<string, unknown>
      );
    case 'ebay_get_shipping_quote':
      return await api.edelivery.getShippingQuote(args.shippingQuoteId as string);

    // eDelivery - Cost & Preferences
    case 'ebay_get_actual_costs':
      return await api.edelivery.getActualCosts(args.params as Record<string, string> | undefined);
    case 'ebay_get_address_preferences':
      return await api.edelivery.getAddressPreferences();
    case 'ebay_create_address_preference':
      return await api.edelivery.createAddressPreference(
        args.addressPreference as Record<string, unknown>
      );
    case 'ebay_get_consign_preferences':
      return await api.edelivery.getConsignPreferences();
    case 'ebay_create_consign_preference':
      return await api.edelivery.createConsignPreference(
        args.consignPreference as Record<string, unknown>
      );

    // eDelivery - Agents & Services
    case 'ebay_get_agents':
      return await api.edelivery.getAgents(args.params as Record<string, string> | undefined);
    case 'ebay_get_battery_qualifications':
      return await api.edelivery.getBatteryQualifications(
        args.params as Record<string, string> | undefined
      );
    case 'ebay_get_dropoff_sites':
      return await api.edelivery.getDropoffSites(args.params as Record<string, string>);
    case 'ebay_get_shipping_services':
      return await api.edelivery.getShippingServices(
        args.params as Record<string, string> | undefined
      );

    // eDelivery - Bundles
    case 'ebay_create_bundle':
      return await api.edelivery.createBundle(args.bundleRequest as Record<string, unknown>);
    case 'ebay_get_bundle':
      return await api.edelivery.getBundle(args.bundleId as string);
    case 'ebay_cancel_bundle':
      return await api.edelivery.cancelBundle(args.bundleId as string);
    case 'ebay_get_bundle_label':
      return await api.edelivery.getBundleLabel(args.bundleId as string);

    // eDelivery - Packages (Single)
    case 'ebay_create_package':
      return await api.edelivery.createPackage(args.packageRequest as Record<string, unknown>);
    case 'ebay_get_package':
      return await api.edelivery.getPackage(args.packageId as string);
    case 'ebay_delete_package':
      return await api.edelivery.deletePackage(args.packageId as string);
    case 'ebay_get_package_by_order_line_item':
      return await api.edelivery.getPackageByOrderLineItem(args.orderLineItemId as string);
    case 'ebay_cancel_package':
      return await api.edelivery.cancelPackage(args.packageId as string);
    case 'ebay_clone_package':
      return await api.edelivery.clonePackage(args.packageId as string);
    case 'ebay_confirm_package':
      return await api.edelivery.confirmPackage(args.packageId as string);

    // eDelivery - Packages (Bulk)
    case 'ebay_bulk_cancel_packages':
      return await api.edelivery.bulkCancelPackages(
        args.bulkCancelRequest as Record<string, unknown>
      );
    case 'ebay_bulk_confirm_packages':
      return await api.edelivery.bulkConfirmPackages(
        args.bulkConfirmRequest as Record<string, unknown>
      );
    case 'ebay_bulk_delete_packages':
      return await api.edelivery.bulkDeletePackages(
        args.bulkDeleteRequest as Record<string, unknown>
      );

    // eDelivery - Labels & Tracking
    case 'ebay_get_labels':
      return await api.edelivery.getLabels(args.params as Record<string, string> | undefined);
    case 'ebay_get_handover_sheet':
      return await api.edelivery.getHandoverSheet(
        args.params as Record<string, string> | undefined
      );
    case 'ebay_get_tracking':
      return await api.edelivery.getTracking(args.params as Record<string, string>);

    // eDelivery - Other
    case 'ebay_create_complaint':
      return await api.edelivery.createComplaint(args.complaintRequest as Record<string, unknown>);

    case 'SearchClaudeCodeDocs':
      return {
        content: [
          {
            type: 'text',
            text: `Tool 'SearchClaudeCodeDocs' called with query: ${args.query}. This tool is not yet fully implemented.`,
          },
        ],
      };

    // Developer API - API Status (public RSS feed)
    case 'ebay_get_api_status': {
      const result = await getApiStatusFeed({
        limit: args.limit as number | undefined,
        status: args.status as 'Resolved' | 'Unresolved' | undefined,
        api: args.api as string | undefined,
      });
      return { items: result.items, ...(result.error && { error: result.error }) };
    }

    // Developer API - Rate Limits
    case 'ebay_get_rate_limits':
      return await api.developer.getRateLimits(
        args.apiContext as string | undefined,
        args.apiName as string | undefined
      );
    case 'ebay_get_user_rate_limits':
      return await api.developer.getUserRateLimits(
        args.apiContext as string | undefined,
        args.apiName as string | undefined
      );

    // Developer API - Client Registration
    case 'ebay_register_client':
      return await api.developer.registerClient(args.clientSettings as Record<string, unknown>);

    // Developer API - Signing Keys
    case 'ebay_get_signing_keys':
      return await api.developer.getSigningKeys();
    case 'ebay_create_signing_key':
      return await api.developer.createSigningKey(
        args.signingKeyCipher ? { signingKeyCipher: args.signingKeyCipher as string } : undefined
      );
    case 'ebay_get_signing_key':
      return await api.developer.getSigningKey(args.signingKeyId as string);

    // Trading API - Listing Management
    case 'ebay_get_active_listings':
      return await api.trading.getActiveListings(
        args.page as number | undefined,
        args.entriesPerPage as number | undefined
      );
    case 'ebay_get_listing':
      return await api.trading.getListing(args.itemId as string);
    case 'ebay_create_listing':
      return await api.trading.createListing(args.item as Record<string, unknown>);
    case 'ebay_revise_listing': {
      const itemId = args.itemId as string;
      const fields = args.fields as Record<string, unknown>;
      try {
        return await api.trading.reviseListing(itemId, fields);
      } catch (error) {
        const message = getErrorMessage(error);
        if (isInventoryBackedReviseFailure(message)) {
          return await reviseInventoryBackedListing(api, itemId, fields, message);
        }
        throw error;
      }
    }
    case 'ebay_end_listing':
      return await api.trading.endListing(args.itemId as string, args.reason as string | undefined);
    case 'ebay_relist_item':
      return await api.trading.relistItem(
        args.itemId as string,
        args.modifications as Record<string, unknown> | undefined
      );
    case 'ebay_upload_images': {
      const imageUrls = args.imageUrls as string[] | undefined;
      const imageFiles = args.imageFiles as string[] | undefined;
      const description = args.description as string | undefined;
      const results: {
        success: boolean;
        id?: string;
        imageUrl?: string;
        error?: string;
        sourceUrl?: string;
        sourceFile?: string;
      }[] = [];

      // Mode 1: Upload from file paths (multipart/form-data)
      if (imageFiles && imageFiles.length > 0) {
        for (const filePath of imageFiles) {
          try {
            const result = await api.media.createImageFromFile(filePath, description);
            results.push({ success: true, id: result.id, imageUrl: result.imageUrl });
          } catch (e) {
            results.push({
              success: false,
              error: e instanceof Error ? e.message : String(e),
              sourceFile: filePath,
            });
          }
        }
      }
      // Mode 2: Upload from URLs (default)
      else if (imageUrls && imageUrls.length > 0) {
        for (const imageUrl of imageUrls) {
          try {
            const result = await api.media.createImageFromUrl(imageUrl, description);
            results.push({ success: true, id: result.id, imageUrl: result.imageUrl });
          } catch (e) {
            results.push({
              success: false,
              error: e instanceof Error ? e.message : String(e),
              sourceUrl: imageUrl,
            });
          }
        }
      } else {
        throw new Error('Provide either imageUrls or imageFiles (at least one)');
      }

      return {
        uploaded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
