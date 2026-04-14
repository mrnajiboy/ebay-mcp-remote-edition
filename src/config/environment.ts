import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { EbayConfig } from '@/types/ebay.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { LocaleEnum } from '@/types/ebay-enums.js';
import { getVersion } from '@/utils/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ScopeDefinition {
  Scope: string;
  Description: string;
}

interface EbaySecretConfigEntry {
  clientId: string;
  clientSecret: string;
  /** The eBay RuName string (used as redirect_uri in token exchange calls) */
  redirectUri: string;
}

interface EbaySecretConfigFile {
  production?: EbaySecretConfigEntry;
  sandbox?: EbaySecretConfigEntry;
}

export type EbayEnvironment = 'production' | 'sandbox';

function readSecretConfigFile(): EbaySecretConfigFile | null {
  const configFile = process.env.EBAY_CONFIG_FILE;
  if (!configFile || !existsSync(configFile)) {
    return null;
  }

  try {
    const raw = readFileSync(configFile, 'utf-8');
    return JSON.parse(raw) as EbaySecretConfigFile;
  } catch (error) {
    console.error('Failed to load EBAY_CONFIG_FILE:', error);
    return null;
  }
}

function getSecretConfigForEnvironment(environment: EbayEnvironment): EbaySecretConfigEntry | null {
  const secretConfig = readSecretConfigFile();
  return secretConfig?.[environment] ?? null;
}

function getProductionScopes(): string[] {
  try {
    const scopesPath = join(__dirname, '../../docs/auth/production_scopes.json');
    const scopesData = readFileSync(scopesPath, 'utf-8');
    const scopes: ScopeDefinition[] = JSON.parse(scopesData);
    const uniqueScopes = new Set<string>();
    scopes.forEach((item) => {
      if (item.Scope) {
        uniqueScopes.add(item.Scope);
      }
    });
    return Array.from(uniqueScopes);
  } catch (error) {
    console.error('Failed to load production scopes:', error);
    return ['https://api.ebay.com/oauth/api_scope'];
  }
}

function getSandboxScopes(): string[] {
  try {
    const scopesPath = join(__dirname, '../../docs/auth/sandbox_scopes.json');
    const scopesData = readFileSync(scopesPath, 'utf-8');
    const scopes: ScopeDefinition[] = JSON.parse(scopesData);
    const uniqueScopes = new Set<string>();
    scopes.forEach((item) => {
      if (item.Scope) {
        uniqueScopes.add(item.Scope);
      }
    });
    return Array.from(uniqueScopes);
  } catch (error) {
    console.error('Failed to load sandbox scopes:', error);
    return ['https://api.ebay.com/oauth/api_scope'];
  }
}

export function getDefaultScopes(environment: EbayEnvironment): string[] {
  return environment === 'production' ? getProductionScopes() : getSandboxScopes();
}

export function getHostedOauthScopes(environment: EbayEnvironment): string[] {
  if (environment === 'production') {
    return [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.marketing',
      'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.finances',
      'https://api.ebay.com/oauth/api_scope/sell.payment.dispute',
      'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.reputation',
      'https://api.ebay.com/oauth/api_scope/sell.reputation.readonly',
      'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
      'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.stores',
      'https://api.ebay.com/oauth/api_scope/sell.stores.readonly',
      'https://api.ebay.com/oauth/scope/sell.edelivery',
      'https://api.ebay.com/oauth/api_scope/commerce.vero',
      'https://api.ebay.com/oauth/api_scope/sell.inventory.mapping',
      'https://api.ebay.com/oauth/api_scope/commerce.message',
      'https://api.ebay.com/oauth/api_scope/commerce.feedback',
      'https://api.ebay.com/oauth/api_scope/commerce.shipping',
    ];
  }

  return [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/buy.order.readonly',
    'https://api.ebay.com/oauth/api_scope/buy.guest.order',
    'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
    'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.marketplace.insights.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly',
    'https://api.ebay.com/oauth/api_scope/buy.shopping.cart',
    'https://api.ebay.com/oauth/api_scope/buy.offer.auction',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.email.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.phone.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.address.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.name.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.status.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.payment.dispute',
    'https://api.ebay.com/oauth/api_scope/sell.item.draft',
    'https://api.ebay.com/oauth/api_scope/sell.item',
    'https://api.ebay.com/oauth/api_scope/sell.reputation',
    'https://api.ebay.com/oauth/api_scope/sell.reputation.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
    'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.stores',
    'https://api.ebay.com/oauth/api_scope/sell.stores.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.vero',
    'https://api.ebay.com/oauth/api_scope/sell.inventory.mapping',
    'https://api.ebay.com/oauth/api_scope/commerce.message',
    'https://api.ebay.com/oauth/api_scope/commerce.feedback',
    'https://api.ebay.com/oauth/api_scope/commerce.shipping',
  ];
}

export function getConfiguredEnvironment(): EbayEnvironment {
  const env = process.env.EBAY_ENVIRONMENT || process.env.EBAY_DEFAULT_ENVIRONMENT || 'production';
  return env === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Parse an eBay RuName string to detect whether it belongs to production or
 * sandbox.  eBay encodes the environment in a dedicated segment of the RuName:
 *
 *   CompanyName-AppNickname-AppName-**PR**-ID   → production
 *   CompanyName-AppNickname-AppName-**SB**-ID   → sandbox
 *
 * @returns `'production'` | `'sandbox'` | `null` (unknown / not detectable)
 */
export function ruNameToEnvironment(ruName: string | undefined | null): EbayEnvironment | null {
  if (!ruName) return null;
  // Look for a word boundary -PR- or -SB- anywhere in the string.
  // Use exact dash-delimited segment matching to avoid false positives (e.g.
  // "PROMO" or "SUBSCRIBE" being mis-detected).
  if (/-PR-/i.test(ruName)) return 'production';
  if (/-SB-/i.test(ruName)) return 'sandbox';
  return null;
}

/**
 * Validate that the credentials configured for `environment` actually match
 * the requested environment by inspecting the RuName segment.
 *
 * Returns an object describing whether the credentials look correct and any
 * human-readable warning or error message.
 */
export function validateCredentialsForEnvironment(environment: EbayEnvironment): {
  valid: boolean;
  detectedEnv: EbayEnvironment | null;
  warning?: string;
  error?: string;
} {
  const config = getEbayConfig(environment);
  const ruName = config.redirectUri;
  const detectedEnv = ruNameToEnvironment(ruName);

  if (detectedEnv === null) {
    // Can't tell from the RuName — treat as valid (no info to contradict it).
    return { valid: true, detectedEnv: null };
  }

  if (detectedEnv !== environment) {
    return {
      valid: false,
      detectedEnv,
      error:
        `Credential mismatch: the RuName "${ruName}" belongs to ${detectedEnv} ` +
        `but the request targets ${environment}. ` +
        `Check EBAY_${environment.toUpperCase()}_RUNAME (or EBAY_RUNAME).`,
    };
  }

  return { valid: true, detectedEnv };
}

export function validateScopes(
  scopes: string[],
  environment: EbayEnvironment
): { warnings: string[]; validScopes: string[] } {
  const validScopes = getDefaultScopes(environment);
  const validScopeSet = new Set(validScopes);
  const warnings: string[] = [];
  const requestedValidScopes: string[] = [];

  scopes.forEach((scope) => {
    if (validScopeSet.has(scope)) {
      requestedValidScopes.push(scope);
    } else {
      const otherEnvironment = environment === 'production' ? 'sandbox' : 'production';
      const otherScopes = getDefaultScopes(otherEnvironment);
      if (otherScopes.includes(scope)) {
        warnings.push(
          `Scope "${scope}" is only available in ${otherEnvironment} environment, not in ${environment}.`
        );
      } else {
        warnings.push(`Scope "${scope}" is not recognized for ${environment} environment.`);
      }
      requestedValidScopes.push(scope);
    }
  });

  return { warnings, validScopes: requestedValidScopes };
}

export function validateEnvironmentConfig(): {
  isValid: boolean;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];

  const rawEnv = process.env.EBAY_ENVIRONMENT || process.env.EBAY_DEFAULT_ENVIRONMENT;
  if (!rawEnv) {
    warnings.push('EBAY_ENVIRONMENT not set; defaulting to sandbox');
  } else if (rawEnv !== 'production' && rawEnv !== 'sandbox') {
    errors.push(`EBAY_ENVIRONMENT "${rawEnv}" is invalid; must be "production" or "sandbox"`);
  }

  if (errors.length === 0) {
    const environment = getConfiguredEnvironment();
    const configForEnv = getSecretConfigForEnvironment(environment);

    if (!configForEnv) {
      // Mirror the same fallback logic used in getEbayConfig() so that
      // per-environment overrides (EBAY_PRODUCTION_CLIENT_ID etc.) are
      // recognised here too and don't produce false-positive errors.
      const effectiveClientId =
        environment === 'production'
          ? process.env.EBAY_PRODUCTION_CLIENT_ID || process.env.EBAY_CLIENT_ID
          : process.env.EBAY_SANDBOX_CLIENT_ID || process.env.EBAY_CLIENT_ID;

      const effectiveClientSecret =
        environment === 'production'
          ? process.env.EBAY_PRODUCTION_CLIENT_SECRET || process.env.EBAY_CLIENT_SECRET
          : process.env.EBAY_SANDBOX_CLIENT_SECRET || process.env.EBAY_CLIENT_SECRET;

      // EBAY_RUNAME is the preferred name (it's a RuName string, not a URL).
      // EBAY_REDIRECT_URI is kept for backward compatibility.
      const effectiveRuName =
        environment === 'production'
          ? process.env.EBAY_PRODUCTION_RUNAME ||
            process.env.EBAY_PRODUCTION_REDIRECT_URI ||
            process.env.EBAY_RUNAME ||
            process.env.EBAY_REDIRECT_URI
          : process.env.EBAY_SANDBOX_RUNAME ||
            process.env.EBAY_SANDBOX_REDIRECT_URI ||
            process.env.EBAY_RUNAME ||
            process.env.EBAY_REDIRECT_URI;

      if (!effectiveClientId) {
        errors.push('EBAY_CLIENT_ID is not set. OAuth will not work.');
      }
      if (!effectiveClientSecret) {
        errors.push('EBAY_CLIENT_SECRET is not set. OAuth will not work.');
      }
      if (!effectiveRuName) {
        warnings.push(
          'EBAY_RUNAME (or legacy EBAY_REDIRECT_URI) is not set for selected environment.'
        );
      }
    }
  }

  return {
    isValid: errors.length === 0,
    warnings,
    errors,
  };
}

export function getEbayConfig(environmentOverride?: EbayEnvironment): EbayConfig {
  const environment = environmentOverride ?? getConfiguredEnvironment();
  const secretConfig = getSecretConfigForEnvironment(environment);

  const fallbackClientId =
    environment === 'production'
      ? process.env.EBAY_PRODUCTION_CLIENT_ID || process.env.EBAY_CLIENT_ID || ''
      : process.env.EBAY_SANDBOX_CLIENT_ID || process.env.EBAY_CLIENT_ID || '';

  const fallbackClientSecret =
    environment === 'production'
      ? process.env.EBAY_PRODUCTION_CLIENT_SECRET || process.env.EBAY_CLIENT_SECRET || ''
      : process.env.EBAY_SANDBOX_CLIENT_SECRET || process.env.EBAY_CLIENT_SECRET || '';

  // Preferred var is EBAY_RUNAME (clearer naming — it IS the RuName, not a URL).
  // EBAY_REDIRECT_URI is kept for backward compatibility.
  const fallbackRedirectUri =
    environment === 'production'
      ? process.env.EBAY_PRODUCTION_RUNAME ||
        process.env.EBAY_PRODUCTION_REDIRECT_URI ||
        process.env.EBAY_RUNAME ||
        process.env.EBAY_REDIRECT_URI
      : process.env.EBAY_SANDBOX_RUNAME ||
        process.env.EBAY_SANDBOX_REDIRECT_URI ||
        process.env.EBAY_RUNAME ||
        process.env.EBAY_REDIRECT_URI;

  return {
    clientId: secretConfig?.clientId || fallbackClientId,
    clientSecret: secretConfig?.clientSecret || fallbackClientSecret,
    redirectUri: secretConfig?.redirectUri || fallbackRedirectUri,
    marketplaceId: (process.env.EBAY_MARKETPLACE_ID ?? '').trim() || 'EBAY_US',
    contentLanguage: (process.env.EBAY_CONTENT_LANGUAGE ?? '').trim() || 'en-US',
    environment,
    accessToken: process.env.EBAY_USER_ACCESS_TOKEN ?? '',
    refreshToken: process.env.EBAY_USER_REFRESH_TOKEN ?? '',
    appAccessToken: process.env.EBAY_APP_ACCESS_TOKEN ?? '',
  };
}

export function getValidationRunnerUserId(environment: EbayEnvironment): string | null {
  const envSpecific =
    environment === 'production'
      ? process.env.VALIDATION_RUNNER_USER_ID_PRODUCTION
      : process.env.VALIDATION_RUNNER_USER_ID_SANDBOX;

  const resolved = (envSpecific ?? process.env.VALIDATION_RUNNER_USER_ID ?? '').trim();
  return resolved || null;
}

export function getTelegramChatId(): string | null {
  const value = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
  return value || null;
}

export function getTelegramBotToken(): string | null {
  const value = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  return value || null;
}

export function getBaseUrl(environment: EbayEnvironment): string {
  return environment === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

export function getOAuthTokenBaseUrl(environment: EbayEnvironment): string {
  return environment === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

export function getIdentityBaseUrl(environment: EbayEnvironment): string {
  return environment === 'production' ? 'https://apiz.ebay.com' : 'https://apiz.sandbox.ebay.com';
}

export function getAuthUrl(environment: EbayEnvironment): string;
export function getAuthUrl(
  clientId: string,
  redirectUri: string | undefined,
  environment: EbayEnvironment,
  locale?: LocaleEnum,
  prompt?: 'login' | 'consent',
  responseType?: 'code',
  state?: string,
  scopes?: string[]
): string;
export function getAuthUrl(
  clientIdOrEnvironment: string,
  redirectUri?: string,
  environment?: EbayEnvironment,
  locale: LocaleEnum = LocaleEnum.en_US,
  prompt: 'login' | 'consent' = 'login',
  responseType: 'code' = 'code',
  state?: string,
  scopes?: string[]
): string {
  if (
    arguments.length === 1 &&
    (clientIdOrEnvironment === 'production' || clientIdOrEnvironment === 'sandbox')
  ) {
    return `${getBaseUrl(clientIdOrEnvironment as EbayEnvironment)}/identity/v1/oauth2/token`;
  }

  const clientId = clientIdOrEnvironment;
  const env = environment ?? 'sandbox';
  const scope = getDefaultScopes(env);

  if (!(clientId && redirectUri)) {
    console.error('clientId and redirectUri are required.');
    return '';
  }

  const authBase = env === 'production' ? 'https://auth.ebay.com' : 'https://auth.sandbox.ebay.com';
  const scopeList = scopes?.join('%20') || scope.join('%20');
  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: responseType,
    prompt,
    locale,
    ...(state ? { state } : {}),
  });

  return `${authBase}/oauth2/authorize?${authorizeParams.toString()}&scope=${scopeList}`;
}

export function getOAuthAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  environment: EbayEnvironment,
  scopes?: string[],
  locale?: string,
  state?: string
): string {
  const authBase =
    environment === 'production' ? 'https://auth.ebay.com' : 'https://auth.sandbox.ebay.com';
  const scopeList = (scopes && scopes.length > 0 ? scopes : getDefaultScopes(environment)).join(
    '%20'
  );
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    ...(locale ? { locale } : {}),
    ...(state ? { state } : {}),
  });
  return `${authBase}/oauth2/authorize?${params.toString()}&scope=${scopeList}`;
}

const iconUrl = (size: string): string => {
  const url = new URL(`../../public/icons/${size}.png`, import.meta.url);
  const path = fileURLToPath(url);
  if (!existsSync(path)) {
    console.warn(`[eBay MCP] Icon not found at ${path}.`);
  }
  return url.toString();
};

export const mcpConfig: Implementation = {
  name: 'eBay API Model Context Protocol Server',
  version: getVersion(),
  title: 'eBay API Model Context Protocol Server',
  websiteUrl: 'https://github.com/mrnajiboy/ebay-mcp-remote-edition',
  icons: [
    { src: iconUrl('16x16'), mimeType: 'image/png', sizes: ['16x16'] },
    { src: iconUrl('32x32'), mimeType: 'image/png', sizes: ['32x32'] },
    { src: iconUrl('48x48'), mimeType: 'image/png', sizes: ['48x48'] },
    { src: iconUrl('128x128'), mimeType: 'image/png', sizes: ['128x128'] },
    { src: iconUrl('256x256'), mimeType: 'image/png', sizes: ['256x256'] },
    { src: iconUrl('512x512'), mimeType: 'image/png', sizes: ['512x512'] },
    { src: iconUrl('1024x1024'), mimeType: 'image/png', sizes: ['1024x1024'] },
  ],
};
