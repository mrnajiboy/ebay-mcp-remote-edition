import { createLogger } from '@/utils/logger.js';

const logger = createLogger('captcha');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptchaType = 'hcaptcha' | 'recaptcha_v2' | 'recaptcha_v3';
export type CaptchaProvider = 'twocaptcha';

export interface CaptchaConfig {
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  /** Optional proxy string (host:port or user:pass@host:port) */
  proxy?: string;
}

export interface CaptchaSolution {
  /** Token to inject into the page's captcha response field */
  token: string;
  provider: CaptchaProvider;
}

export interface CaptchaError extends Error {
  provider: CaptchaProvider;
  code?: string;
}

function makeCaptchaError(provider: CaptchaProvider, message: string, code?: string): CaptchaError {
  const error = new Error(message) as CaptchaError;
  error.provider = provider;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Provider-agnostic solver interface
// ---------------------------------------------------------------------------

interface CaptchaProviderClient {
  name: CaptchaProvider;
  createTask(config: CaptchaConfig): Promise<{ taskId: string }>;
  getResult(taskId: string): Promise<CaptchaSolution | null>;
}

// ---------------------------------------------------------------------------
// 2Captcha client
// ---------------------------------------------------------------------------

const TWOCAPTCHA_API_URL = 'https://2captcha.com';

interface TwoCaptchaInResponse {
  status?: number;
  request?: string;
  error_text?: string;
  error_id?: number;
}

interface TwoCaptchaResResponse {
  status?: number;
  request?: string;
  error_text?: string;
  error_id?: number;
}

class TwoCaptchaClient implements CaptchaProviderClient {
  public readonly name: CaptchaProvider = 'twocaptcha';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private captchaTypeToMethod(type: CaptchaType): string {
    switch (type) {
      case 'hcaptcha':
        return 'hcaptcha';
      case 'recaptcha_v2':
        return 'usercaptcha';
      case 'recaptcha_v3':
        return 'userrecaptcha';
    }
  }

  private buildFormData(payload: Record<string, string | undefined>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) {
        params.append(key, value);
      }
    }
    return params;
  }

  async createTask(config: CaptchaConfig): Promise<{ taskId: string }> {
    const method = this.captchaTypeToMethod(config.type);

    const payload: Record<string, string | undefined> = {
      key: this.apiKey,
      method,
      sitekey: config.siteKey,
      pageurl: config.pageUrl,
      proxy: config.proxy,
      proxytype: config.proxy ? 'http' : undefined,
      json: '1', // Force JSON response format
    };

    const formData = this.buildFormData(payload);

    const response = await fetch(`${TWOCAPTCHA_API_URL}/in.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData,
    });

    // 2Captcha may return either JSON or plaintext OK|taskId format
    const text = await response.text();
    let data: TwoCaptchaInResponse;

    if (text.startsWith('{')) {
      data = JSON.parse(text) as TwoCaptchaInResponse;
    } else {
      // Parse plaintext OK|taskId or ERROR|message
      const parts = text.split('|');
      if (parts[0] === 'OK' && parts[1]) {
        return { taskId: parts[1] };
      }
      data = { error_text: parts[1] ?? text, error_id: -1 };
    }

    if (data.status !== 1 || !data.request) {
      const errorMessage = data.error_text ?? `2Captcha error_id: ${data.error_id}`;
      throw makeCaptchaError(
        this.name,
        `2Captcha createTask failed: ${errorMessage}`,
        String(data.error_id)
      );
    }

    return { taskId: data.request };
  }

  async getResult(taskId: string): Promise<CaptchaSolution | null> {
    const payload: Record<string, string> = {
      key: this.apiKey,
      action: 'get',
      json: '1', // Force JSON response format
      id: taskId,
    };

    const formData = this.buildFormData(payload);

    const response = await fetch(`${TWOCAPTCHA_API_URL}/res.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData,
    });

    // Handle both JSON and plaintext formats
    const text = await response.text();
    let data: TwoCaptchaResResponse;

    if (text.startsWith('{')) {
      data = JSON.parse(text) as TwoCaptchaResResponse;
    } else {
      // Parse plaintext OK|solution or CAPCHA_NOT_READY
      const parts = text.split('|');
      if (parts[0] === 'OK' && parts[1]) {
        return { token: parts[1], provider: this.name };
      }
      // CAPCHA_NOT_READY or other error
      data = { error_text: parts[0] ?? text, error_id: 1 };
    }

    if (data.error_text && data.error_id !== 0) {
      throw new Error(`2Captcha getResult error: ${data.error_text}`);
    }

    if (data.status === 1 && data.request) {
      return { token: data.request, provider: this.name };
    }

    // Still processing (CAPCHA_NOT_READY)
    return null;
  }
}

// ---------------------------------------------------------------------------
// Solver factory
// ---------------------------------------------------------------------------

function resolveProvider(): CaptchaProviderClient | null {
  const twoCaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (twoCaptchaKey) {
    logger.info('2Captcha client initialized');
    return new TwoCaptchaClient(twoCaptchaKey);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_MS = 60_000;

export async function solveCaptcha(
  config: CaptchaConfig,
  options: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {}
): Promise<CaptchaSolution> {
  const provider = resolveProvider();

  if (!provider) {
    throw new Error('No captcha solver configured. Set TWOCAPTCHA_API_KEY environment variable.');
  }

  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWait = options.maxWaitMs ?? DEFAULT_MAX_POLL_MS;

  logger.info(`Attempting captcha solve via ${provider.name} (type=${config.type})`);

  try {
    const { taskId } = await provider.createTask(config);
    logger.debug(`Task created: ${taskId} on ${provider.name}`);

    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), pollInterval);
      });

      const solution = await provider.getResult(taskId);
      if (solution) {
        logger.info(`Captcha solved via ${provider.name}`);
        return solution;
      }
    }

    const timeoutError = makeCaptchaError(
      provider.name,
      `${provider.name} timed out after ${maxWait}ms`
    );
    throw timeoutError;
  } catch (err) {
    let providerError: CaptchaError;
    if (err instanceof Error && 'provider' in err) {
      providerError = err as CaptchaError;
    } else {
      providerError = makeCaptchaError(
        provider.name,
        err instanceof Error ? err.message : String(err)
      );
    }
    logger.warn(`${provider.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw providerError;
  }
}

/**
 * Minimal page interface compatible with Playwright Page.
 */
export interface CaptchaPage {
  evaluate: {
    <T>(pageFunction: string | (() => T)): Promise<T>;
    <T, A>(pageFunction: string | ((arg: A) => T), arg: A): Promise<T>;
  };
}

/**
 * Inject the captcha solution token into a Playwright page.
 */
export async function injectCaptchaToken(
  page: CaptchaPage,
  type: CaptchaType,
  token: string
): Promise<void> {
  if (type === 'hcaptcha') {
    await page.evaluate((t: string) => {
      const textarea = document.querySelector('textarea[name="h-captcha-response"]');
      if (textarea) {
        (textarea as HTMLTextAreaElement).value = t;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, token);
  } else {
    await page.evaluate((t: string) => {
      const iframe = document.querySelector('iframe[title="reCAPTCHA"], iframe[src*="recaptcha"]');
      if (iframe) {
        const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
        if (iframeDoc) {
          const textarea = iframeDoc.querySelector('textarea[name="g-recaptcha-response"]');
          if (textarea) {
            (textarea as HTMLTextAreaElement).value = t;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
    }, token);
  }
}

/**
 * Check if a captcha challenge is present on a Playwright page.
 */
export async function detectCaptcha(page: CaptchaPage): Promise<CaptchaType | null> {
  return await page.evaluate((): CaptchaType | null => {
    const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
    if (hcaptchaIframe) return 'hcaptcha';

    const hcaptchaWidget = document.querySelector('.hcaptcha');
    if (hcaptchaWidget) return 'hcaptcha';

    const recaptchaIframe = document.querySelector(
      'iframe[src*="recaptcha.net"], iframe[src*="recaptcha"]'
    );
    if (recaptchaIframe) {
      const src = (recaptchaIframe as HTMLIFrameElement).src || '';
      if (src.includes('render=explicit')) return 'recaptcha_v3';
      return 'recaptcha_v2';
    }

    const recaptchaWidget = document.querySelector('.g-recaptcha');
    if (recaptchaWidget) return 'recaptcha_v2';

    return null;
  });
}

/**
 * Extract the captcha site key from the page.
 */
export async function extractSiteKey(page: CaptchaPage, type: CaptchaType): Promise<string | null> {
  return await page.evaluate((ct: string): string | null => {
    const captchaType = ct as CaptchaType;
    if (captchaType === 'hcaptcha') {
      const hcaptchaEl = document.querySelector('.hcaptcha[data-sitekey]');
      if (hcaptchaEl) {
        return (hcaptchaEl as HTMLElement).getAttribute('data-sitekey');
      }

      const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
      if (hcaptchaIframe) {
        const src = (hcaptchaIframe as HTMLIFrameElement).src || '';
        const match = /sitekey=([^&]+)/.exec(src);
        if (match) return match[1];
      }

      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = /HCaptcha\.render\([^,]+,\s*['"]([^'"]+)['"]/.exec(text);
        if (match) return match[1];
      }

      return null;
    } else {
      const recaptchaEl = document.querySelector('.g-recaptcha[data-sitekey]');
      if (recaptchaEl) {
        return (recaptchaEl as HTMLElement).getAttribute('data-sitekey');
      }

      const recaptchaIframe = document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="recaptcha.net"]'
      );
      if (recaptchaIframe) {
        const src = (recaptchaIframe as HTMLIFrameElement).src || '';
        const match = /k=([^&]+)/.exec(src);
        if (match) return match[1];
      }

      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = /grecaptcha\.render\([^,]+,\s*['"]([^'"]+)['"]/.exec(text);
        if (match) return match[1];
      }

      return null;
    }
  }, type);
}

/**
 * Helper: wait for captcha to appear on page, then solve and inject.
 */
export async function waitForAndSolveCaptcha(
  page: CaptchaPage,
  options: {
    pageUrl: string;
    maxWaitMs?: number;
    checkIntervalMs?: number;
    proxy?: string;
  }
): Promise<CaptchaSolution | null> {
  const maxWait = options.maxWaitMs ?? 30_000;
  const checkInterval = options.checkIntervalMs ?? 1_000;
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    const captchaType = await detectCaptcha(page);
    if (captchaType) {
      logger.info(`Detected ${captchaType} on ${options.pageUrl}`);

      const siteKey = await extractSiteKey(page, captchaType);
      if (!siteKey) {
        logger.error('Captcha detected but site key could not be extracted');
        throw new Error('Could not extract captcha site key from page');
      }

      logger.debug(`Extracted site key: ${siteKey}`);

      const solution = await solveCaptcha({
        type: captchaType,
        siteKey,
        pageUrl: options.pageUrl,
        proxy: options.proxy,
      });

      await injectCaptchaToken(page, captchaType, solution.token);
      logger.info(`Injected ${captchaType} solution token`);

      return solution;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), checkInterval);
    });
  }

  logger.debug('No captcha detected within timeout');
  return null;
}
