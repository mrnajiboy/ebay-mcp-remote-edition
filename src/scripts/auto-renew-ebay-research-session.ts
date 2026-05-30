import {
  clearEbayResearchAuthCache,
  type EbayResearchAuthInspection,
  inspectEbayResearchAuthState,
  inspectEbayResearchSessionPersistence,
  type ResearchStorageState,
  validateAndStoreEbayResearchSessionToKv,
} from '../validation/providers/ebay-research.js';
import {
  createEbayResearchSessionStoreResolution,
  type EbayResearchSessionStoreBackend,
} from '../validation/providers/ebay-research-session-store.js';
import { scheduleEbayResearchSessionAlerts } from '../validation/providers/ebay-research-session-alerts.js';
import { loadChromium } from './playwright-runtime.js';
import type { CaptchaPage } from '../captcha/captcha.js';
import {
  detectCaptcha,
  extractSiteKey,
  injectCaptchaToken,
  solveCaptcha,
  triggerCaptchaVerification,
  type CaptchaType,
} from '../captcha/captcha.js';

const configuredMarketplace = process.env.EBAY_RESEARCH_BOOTSTRAP_MARKETPLACE?.trim();
const marketplace =
  configuredMarketplace && configuredMarketplace.length > 0 ? configuredMarketplace : 'EBAY-US';
// Used as the redirect target URL after login to confirm session access
const _researchUrl = `https://www.ebay.com/sh/research?marketplace=${encodeURIComponent(marketplace)}`;

const EBAY_SIGNIN_URL = 'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&UsingSSL=1';
const DEFAULT_CAPTCHA_SOLVE_MAX_WAIT_MS = 300_000;
const DEFAULT_CAPTCHA_POLL_INTERVAL_MS = 3_000;

function getExpectedVerificationSessionSource(
  selectedStore: EbayResearchSessionStoreBackend
): 'kv' | 'filesystem' | null {
  if (selectedStore === 'cloudflare_kv' || selectedStore === 'upstash-redis') {
    return 'kv';
  }

  if (selectedStore === 'filesystem') {
    return 'filesystem';
  }

  return null;
}

function getChromiumChannel(): string | undefined {
  const configuredChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
  return configuredChannel && configuredChannel.length > 0 ? configuredChannel : undefined;
}

function alertingLooksConfigured(): boolean {
  return [
    process.env.QSTASH_URL,
    process.env.QSTASH_TOKEN,
    process.env.QSTASH_CURRENT_SIGNING_KEY,
    process.env.QSTASH_NEXT_SIGNING_KEY,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
    process.env.EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL,
    process.env.PUBLIC_BASE_URL,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
}

function normalizePublicBaseUrl(): string {
  const explicitBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const configuredBaseUrl = process.env.EBAY_MCP_BASE_URL?.trim().replace(/\/$/, '');
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  const host = (process.env.MCP_HOST ?? 'localhost').trim() || 'localhost';
  const normalizedHost = host === '0.0.0.0' ? 'localhost' : host;
  const port = Number(process.env.PORT ?? 3000);
  return `http://${normalizedHost}:${port}`;
}

function getManualCaptureUrl(): string {
  return `${normalizePublicBaseUrl()}/admin/playwright-capture`;
}

function sanitizeChallengeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'unknown';
  }
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[AutoRenew] Ignoring invalid ${name}=${rawValue}; using ${fallback}ms.`);
    return fallback;
  }

  return parsed;
}

function getCaptchaSolveOptions(): { maxWaitMs: number; pollIntervalMs: number } {
  return {
    maxWaitMs: getPositiveIntegerEnv(
      'EBAY_RESEARCH_CAPTCHA_MAX_WAIT_MS',
      DEFAULT_CAPTCHA_SOLVE_MAX_WAIT_MS
    ),
    pollIntervalMs: getPositiveIntegerEnv(
      'EBAY_RESEARCH_CAPTCHA_POLL_INTERVAL_MS',
      DEFAULT_CAPTCHA_POLL_INTERVAL_MS
    ),
  };
}

class ManualResearchSessionRequiredError extends Error {
  public readonly errorCode = 'MANUAL_RESEARCH_SESSION_REQUIRED';
  public readonly manualAction = 'playwright_capture';
  public readonly manualCaptureUrl = getManualCaptureUrl();
  public readonly challengeType: CaptchaType;
  public readonly challengeUrl: string;

  constructor(challengeType: CaptchaType, challengeUrl: string) {
    super(
      `eBay presented a ${challengeType} challenge during Research session auto-renewal. ` +
        'Manual browser capture is required to refresh the session.'
    );
    this.name = 'ManualResearchSessionRequiredError';
    this.challengeType = challengeType;
    this.challengeUrl = sanitizeChallengeUrl(challengeUrl);
  }
}

/**
 * Detect anti-bot challenges during auto-renewal, solve them when a captcha
 * provider is configured, and fall back to the supported manual capture flow
 * when the challenge cannot be completed automatically.
 */
async function handleCaptchaChallenge(
  page: Parameters<typeof detectCaptcha>[0] & { url(): string }
): Promise<void> {
  const captchaType = await detectCaptcha(page);
  if (!captchaType) {
    return;
  }

  console.warn(`[AutoRenew] Detected ${captchaType} challenge — attempting automatic solve...`);

  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey) {
    console.warn('[AutoRenew] TWOCAPTCHA_API_KEY not set — falling back to manual capture.');
    throw new ManualResearchSessionRequiredError(captchaType, page.url());
  }

  const siteKey = await extractSiteKey(page, captchaType);
  if (!siteKey) {
    console.warn(`[AutoRenew] Could not extract site key for ${captchaType}.`);
    throw new ManualResearchSessionRequiredError(captchaType, page.url());
  }

  try {
    const solveOptions = getCaptchaSolveOptions();
    const solution = await solveCaptcha(
      {
        type: captchaType,
        siteKey,
        pageUrl: page.url(),
      },
      solveOptions
    );
    console.log(`[AutoRenew] Captcha solved — injecting token (${solution.token.length} chars)`);
    await injectCaptchaToken(page, captchaType, solution.token);
    console.log('[AutoRenew] Token injected successfully');

    const verificationTriggered = await triggerCaptchaVerification(page, captchaType);
    if (!verificationTriggered) {
      throw new Error('Could not trigger captcha verification control after token injection.');
    }

    console.log('[AutoRenew] Captcha verification control triggered');
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 2_000);
    });

    const challengeCleared = await waitForCaptchaChallengeToClear(page);
    if (!challengeCleared) {
      throw new Error('Captcha challenge did not clear after verification trigger.');
    }
  } catch (error) {
    console.warn(
      `[AutoRenew] Automatic ${captchaType} solve failed — falling back to manual capture: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new ManualResearchSessionRequiredError(captchaType, page.url());
  }
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.length === 0) {
    throw new Error(
      `[AutoRenew] Required environment variable ${name} is not set. ` +
        `Set EBAY_USERNAME and EBAY_PASSWORD for auto-renewal.`
    );
  }
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

/**
 * Check if an element is visible (not hidden, not zero-size, not display:none).
 */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && el.tagName !== 'INPUT') {
    return false;
  }
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

/**
 * Find a VISIBLE form input matching a given strategy.
 * Strategies: name, id, attribute, placeholder, aria-label, type, test-id.
 * Returns the element ref index (-1 if not found).
 */
async function findVisibleInput(
  page: AnyPage,
  strategy: {
    name?: string;
    id?: string;
    type?: string;
    placeholderPattern?: string;
    ariaLabelPattern?: string;
    testId?: string;
    attribute?: { key: string; value: string };
  }
): Promise<HTMLInputElement | null> {
  return await (page as unknown as CaptchaPage).evaluate((strat) => {
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    for (const input of Array.from(inputs)) {
      if (input.type === 'hidden' || input.type === 'submit' || input.type === 'checkbox') {
        continue;
      }
      if (!isVisible(input)) {
        continue;
      }
      let match = false;
      if (input.name?.toLowerCase() === strat.name?.toLowerCase()) {
        match = true;
      }
      if (input.id?.toLowerCase() === strat.id?.toLowerCase()) {
        match = true;
      }
      if (strat.type && input.type === strat.type) {
        match = true;
      }
      if (strat.placeholderPattern && input.placeholder) {
        if (input.placeholder.toLowerCase().includes(strat.placeholderPattern.toLowerCase())) {
          match = true;
        }
      }
      if (strat.ariaLabelPattern && input.getAttribute('aria-label')) {
        if (
          input
            .getAttribute('aria-label')!
            .toLowerCase()
            .includes(strat.ariaLabelPattern.toLowerCase())
        ) {
          match = true;
        }
      }
      if (strat.testId) {
        const tid =
          input.getAttribute('data-testid') ||
          input.getAttribute('data-test-id') ||
          input.getAttribute('data-playwright-test-trigger-id');
        if (tid?.toLowerCase() === strat.testId.toLowerCase()) {
          match = true;
        }
      }
      if (strat.attribute && input.getAttribute(strat.attribute.key) === strat.attribute?.value) {
        match = true;
      }
      if (match) {
        return input;
      }
    }
    return null;
  }, strategy);
}

/**
 * Find a VISIBLE button matching text content or selector.
 */
async function findVisibleButton(page: AnyPage, labelPattern: string): Promise<HTMLElement | null> {
  return await (page as unknown as CaptchaPage).evaluate((pattern) => {
    const buttons = document.querySelectorAll<HTMLElement>(
      'button, input[type="submit"], [role="button"]'
    );
    for (const btn of Array.from(buttons)) {
      if (!isVisible(btn)) continue;
      const text = `${btn.innerText ?? ''} ${(btn as HTMLInputElement).value ?? ''}`.trim();
      if (text.toLowerCase().includes(pattern.toLowerCase())) {
        return btn;
      }
    }
    return null;
  }, labelPattern);
}

/**
 * Fill a form field by trying multiple strategies in order.
 */
async function fillField(
  page: AnyPage,
  value: string,
  strategies: {
    name?: string;
    id?: string;
    type?: string;
    placeholderPattern?: string;
    ariaLabelPattern?: string;
    testId?: string;
    attribute?: { key: string; value: string };
  }[]
): Promise<string | null> {
  for (const strat of strategies) {
    const el = await findVisibleInput(page, strat);
    if (el !== null) {
      const stratDesc = JSON.stringify(strat);
      await (page as unknown as CaptchaPage).evaluate(
        ({ value: val, index }: { value: string; index: number }) => {
          const inputs = document.querySelectorAll<HTMLInputElement>('input');
          let count = 0;
          for (const input of Array.from(inputs)) {
            if (input.type === 'hidden' || input.type === 'submit' || input.type === 'checkbox')
              continue;
            if (input.offsetParent === null && input.tagName !== 'INPUT') continue;
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            count++;
            if (count === index + 1) {
              input.focus();
              input.value = val;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        },
        { value, index: -1 }
      );
      // Actually fill via focused element approach — use page.type equivalent
      // by focusing then typing
      await (page as unknown as CaptchaPage).evaluate((val: string) => {
        const active = document.activeElement as HTMLInputElement;
        if (active?.tagName === 'INPUT') {
          active.value = val;
          active.dispatchEvent(new Event('input', { bubbles: true }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, value);
      // Use Playwright's native fill if available
      try {
        const pwPage = page;
        if (pwPage.fill) {
          // Try to fill using Playwright's native method on the first visible matching input
          const selector = buildSelectorFromStrat(strat);
          if (selector) {
            await pwPage.fill(selector, value);
            return stratDesc;
          }
        }
      } catch {
        // Playwright fill not available or failed — DOM fill already done above
      }
      // Fallback: use Playwright's native type if available
      try {
        const pwPage = page;
        if (pwPage.locator) {
          const selector = buildSelectorFromStrat(strat);
          if (selector) {
            await pwPage.locator(selector).first().fill(value);
            return stratDesc;
          }
        }
      } catch {
        // Already filled via DOM above
      }
      return stratDesc;
    }
  }
  return null;
}

function buildSelectorFromStrat(strat: Record<string, unknown>): string | null {
  if (strat.id) return `input#${strat.id as string}`;
  if (strat.name) return `input[name="${strat.name as string}"]`;
  if (strat.type) return `input[type="${strat.type as string}"]`;
  if (strat.testId) return `[data-testid="${strat.testId as string}"]`;
  if (strat.attribute) {
    const attr = strat.attribute as { key: string; value: string };
    return `[${attr.key}="${attr.value}"]`;
  }
  return null;
}

/**
 * Click a button by trying text content matching, then CSS selectors.
 */
async function clickButton(page: AnyPage, labelPatterns: string[]): Promise<string | null> {
  // Try Playwright native click first
  try {
    const pwPage = page;
    if (pwPage.getByRole) {
      for (const label of labelPatterns) {
        try {
          await pwPage.getByRole('button', { name: label }).first().click();
          return `getByRole('button', '${label}')`;
        } catch {
          // try next
        }
      }
    }
  } catch {
    // getByRole not available
  }

  // Fallback: DOM-based click
  for (const pattern of labelPatterns) {
    const btn = await findVisibleButton(page, pattern);
    if (btn !== null) {
      await (page as unknown as CaptchaPage).evaluate((pattern: string) => {
        const buttons = document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], [role="button"]'
        );
        for (const btn of Array.from(buttons)) {
          const style = window.getComputedStyle(btn);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const text = `${btn.innerText ?? ''} ${(btn as HTMLInputElement).value ?? ''}`.trim();
          if (text.toLowerCase().includes(pattern.toLowerCase())) {
            btn.click();
            break;
          }
        }
      }, pattern);
      return `button containing "${pattern}"`;
    }
  }

  // Try classic CSS selectors as last resort
  const classicSelectors = [
    '#signin-continue-btn',
    'button#signin-continue-btn',
    '#sgnBt',
    'button#sgnBt',
    'button[type="submit"]',
    'input[type="submit"]',
  ];
  for (const sel of classicSelectors) {
    try {
      await (page as unknown as CaptchaPage).evaluate((s: string) => {
        const el = document.querySelector<HTMLElement>(s);
        if (el && el.offsetParent !== null) {
          el.click();
        }
      }, sel);
      return sel;
    } catch {
      // skip
    }
  }
  return null;
}

/**
 * Wait for the page URL to contain a given substring.
 */
async function waitForUrlContains(
  page: AnyPage,
  substring: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.url().includes(substring)) return true;
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });
  }
  return false;
}

async function waitForCaptchaChallengeToClear(
  page: Parameters<typeof detectCaptcha>[0] & { url(): string },
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const captchaType = await detectCaptcha(page);
    const stillOnChallengeUrl = /captcha|challenge|pardon/iu.test(currentUrl);

    if (!captchaType && !stillOnChallengeUrl) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1_000);
    });
  }

  return false;
}

async function main(): Promise<void> {
  const username = getRequiredEnvVar('EBAY_USERNAME');
  const password = getRequiredEnvVar('EBAY_PASSWORD');

  console.log(
    `[AutoRenew] Starting headless eBay Research session auto-renewal for marketplace ${marketplace}...`
  );

  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: true,
    channel: getChromiumChannel(),
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── Step 1: Navigate to sign-in page ────────────────────────────────────
    console.log('[AutoRenew] Navigating to eBay sign-in page...');
    await page.goto(EBAY_SIGNIN_URL, { waitUntil: 'domcontentloaded' });

    // Wait for page to fully render (captcha + sign-in form)
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 3_000);
    });

    // Auto-solve captcha if encountered on the sign-in page
    await handleCaptchaChallenge(page as unknown as CaptchaPage & { url(): string });

    // Wait after captcha solve for sign-in form to render
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 3_000);
    });

    // Verify we're on a sign-in page (not already logged in or on captcha)
    const afterCaptchaUrl = page.url();
    if (!afterCaptchaUrl.includes('signin.ebay.com') && !afterCaptchaUrl.includes('SignIn')) {
      if (afterCaptchaUrl.includes('/sh/research')) {
        console.log('[AutoRenew] Already at research page — session was still valid!');
        // Skip to Step 5
      } else {
        console.warn(`[AutoRenew] Unexpected URL after captcha: ${afterCaptchaUrl}`);
      }
    }

    // ── Step 2: Fill username/email ─────────────────────────────────────────
    console.log('[AutoRenew] Filling username/email...');

    // Strategy-based field finding — no CSS i-flag, proper visibility check
    const userIdStrategies = [
      // Classic eBay selectors
      { name: 'userid' },
      { id: 'userid' },
      { testId: 'userid' },
      // Modern eBay sign-in (two-step flow)
      { placeholderPattern: 'Email' },
      { placeholderPattern: 'email' },
      { placeholderPattern: 'User ID' },
      { placeholderPattern: 'user' },
      { ariaLabelPattern: 'email' },
      { ariaLabelPattern: 'user' },
      { ariaLabelPattern: 'Email or mobile' },
      // Generic fallbacks
      { type: 'email' },
    ];

    const filledUser = await fillField(page, username, userIdStrategies);
    if (filledUser) {
      console.log(`[AutoRenew] Filled username using strategy: ${filledUser}`);
    } else {
      // Debug: dump all visible inputs
      console.warn('[AutoRenew] Username field not found. Dumping visible form fields...');
      await (page as unknown as CaptchaPage)
        .evaluate(() => {
          const inputs = document.querySelectorAll<HTMLInputElement>('input');
          const results: string[] = [];
          for (const input of Array.from(inputs)) {
            if (input.type === 'hidden') continue;
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            results.push(
              `[${input.type}] id=${input.id} name=${input.name} placeholder="${input.placeholder}" ` +
                `aria-label="${input.getAttribute('aria-label') ?? ''}" ` +
                `data-testid="${input.getAttribute('data-testid') ?? ''}"`
            );
          }
          return results;
        })
        .then((fields: string[]) => {
          console.warn(`[AutoRenew] Visible inputs on page: ${JSON.stringify(fields)}`);
        });

      throw new Error(
        'Could not find username/email field on eBay sign-in page. ' +
          'The page structure may have changed. See visible inputs above. Manual bootstrap required.'
      );
    }

    // Wait for field to register
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1_500);
    });

    // ── Step 3: Click Continue / Sign-in button ──────────────────────────────
    console.log('[AutoRenew] Clicking continue/sign-in button...');

    const clickedStep3 = await clickButton(page, [
      'Continue',
      'Sign in',
      'Next',
      'Log in',
      'Continue to sign in',
    ]);

    if (clickedStep3) {
      console.log(`[AutoRenew] Clicked button: ${clickedStep3}`);
    } else {
      throw new Error(
        'Could not find sign-in/continue button on eBay sign-in page. ' +
          'The page structure may have changed. Manual bootstrap required.'
      );
    }

    // ── Step 4: Wait for password page (two-step eBay sign-in) ──────────────
    console.log('[AutoRenew] Waiting for password page or redirect...');

    // Wait for page transition — eBay two-step sign-in redirects to password page
    // Give it up to 15 seconds for the page to navigate
    const passwordPageLoaded = await waitForUrlContains(page, 'pass', 15_000);

    // Check current URL to determine next step
    let urlAfterContinue = page.url();

    // Auto-solve captcha if encountered after clicking continue
    await handleCaptchaChallenge(page as unknown as CaptchaPage & { url(): string });
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 3_000);
    });

    urlAfterContinue = page.url();

    if (urlAfterContinue.includes('/sh/research')) {
      console.log('[AutoRenew] Already at research page — session may have been valid!');
    } else if (
      passwordPageLoaded ||
      urlAfterContinue.includes('pass') ||
      urlAfterContinue.includes('password') ||
      urlAfterContinue.includes('SignIn') ||
      urlAfterContinue.includes('signin')
    ) {
      // On password page — fill password
      console.log('[AutoRenew] On password page — filling password...');

      // Wait for password field to be visible
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 2_000);
      });

      const passwordStrategies = [
        // Classic eBay selectors
        { name: 'pass' },
        { id: 'pass' },
        { testId: 'pass' },
        // Modern eBay
        { placeholderPattern: 'Password' },
        { ariaLabelPattern: 'password' },
        // Generic
        { type: 'password' },
      ];

      const filledPass = await fillField(page, password, passwordStrategies);
      if (filledPass) {
        console.log(`[AutoRenew] Filled password using strategy: ${filledPass}`);
      } else {
        // Debug: dump all visible inputs
        console.warn('[AutoRenew] Password field not found. Dumping visible form fields...');
        await (page as unknown as CaptchaPage)
          .evaluate(() => {
            const inputs = document.querySelectorAll<HTMLInputElement>('input');
            const results: string[] = [];
            for (const input of Array.from(inputs)) {
              if (input.type === 'hidden') continue;
              const style = window.getComputedStyle(input);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              results.push(
                `[${input.type}] id=${input.id} name=${input.name} placeholder="${input.placeholder}" ` +
                  `aria-label="${input.getAttribute('aria-label') ?? ''}" ` +
                  `data-testid="${input.getAttribute('data-testid') ?? ''}"`
              );
            }
            return results;
          })
          .then((fields: string[]) => {
            console.warn(`[AutoRenew] Visible inputs on password page: ${JSON.stringify(fields)}`);
          });

        throw new Error(
          'Could not find password field on eBay sign-in page. ' +
            'Auto-renewal requires manual inspection of the sign-in flow. See visible inputs above.'
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 1_500);
      });

      // Click sign-in submit
      console.log('[AutoRenew] Clicking sign-in submit...');
      const clickedSubmit = await clickButton(page, ['Sign in', 'Sign In', 'Log in', 'Continue']);

      if (clickedSubmit) {
        console.log(`[AutoRenew] Clicked sign-in: ${clickedSubmit}`);
      } else {
        throw new Error('Could not find sign-in submit button on eBay password page.');
      }
    } else {
      // Neither research page nor password page — something unexpected
      console.warn(`[AutoRenew] Unexpected URL after clicking continue: ${urlAfterContinue}`);
      // Dump visible inputs for debugging
      await (page as unknown as CaptchaPage)
        .evaluate(() => {
          const inputs = document.querySelectorAll<HTMLInputElement>('input');
          const results: string[] = [];
          for (const input of Array.from(inputs)) {
            if (input.type === 'hidden') continue;
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            results.push(
              `[${input.type}] id=${input.id} name=${input.name} placeholder="${input.placeholder}"`
            );
          }
          return results;
        })
        .then((fields: string[]) => {
          console.warn(`[AutoRenew] Visible inputs: ${JSON.stringify(fields)}`);
        });

      throw new Error(
        `Unexpected page after clicking continue: ${urlAfterContinue}. ` +
          'Manual bootstrap may be required.'
      );
    }

    // ── Step 5: Wait for redirect to research page ───────────────────────────
    console.log('[AutoRenew] Waiting for redirect to eBay Research...');

    // Wait up to 60s for the redirect
    const redirected = await waitForUrlContains(page, '/sh/research', 60_000);

    if (!redirected) {
      const finalUrl = page.url();
      // Check for 2FA or other blocking pages
      if (
        finalUrl.includes('challenge') ||
        finalUrl.includes('2fa') ||
        finalUrl.includes('twofactor') ||
        finalUrl.includes('verify')
      ) {
        throw new Error(
          `eBay is asking for 2FA / verification at (${finalUrl}). ` +
            'Auto-renewal requires a manual bootstrap for accounts with 2FA.'
        );
      }

      // Check for MFA/security questions
      if (
        finalUrl.includes('myo') ||
        finalUrl.includes('myaccount') ||
        finalUrl.includes('security')
      ) {
        throw new Error(
          `eBay redirected to a security page (${finalUrl}). ` +
            'Auto-renewal cannot handle account security challenges. Manual bootstrap required.'
        );
      }

      throw new Error(
        `Auto-renewal did not reach eBay Research after login. Current URL: ${finalUrl}. ` +
          'This may indicate a changed sign-in flow or an account issue.'
      );
    }

    // ── Step 6: Auto-solve captcha on research page if encountered ───────────
    await handleCaptchaChallenge(page as unknown as CaptchaPage & { url(): string });

    const confirmedUrl = page.url();
    console.log(`[AutoRenew] Reached eBay Research at: ${confirmedUrl}`);

    // Confirm we can access the research UI
    if (!confirmedUrl.includes('/sh/research')) {
      throw new Error(`Research UI access could not be confirmed (currentUrl=${confirmedUrl}).`);
    }

    // ── Step 7: Persist storage state ────────────────────────────────────────
    console.log('[AutoRenew] Capturing storage state...');
    const storageState = await context.storageState<ResearchStorageState>();
    const validationPersistence = await validateAndStoreEbayResearchSessionToKv(
      marketplace,
      storageState,
      'storage_state'
    );
    clearEbayResearchAuthCache();
    const persistence = await inspectEbayResearchSessionPersistence(marketplace);

    console.log(
      `[AutoRenew] wrote storage state to ${persistence.sessionStoreSelected} key=${persistence.canonicalStateKey ?? 'null'} bytes=${persistence.storageStateBytes}`
    );
    console.log(
      `[AutoRenew] validation status=${validationPersistence.validation.responseStatus ?? 'null'} modules=${validationPersistence.validation.modulesSeen.join(',') || 'none'} cookieCount=${validationPersistence.cookieCount}`
    );
    console.log(
      `[AutoRenew] canonical storage-state key ${persistence.canonicalStateKey ?? 'null'} exists=${persistence.storageStateExists} bytes=${persistence.storageStateBytes} valid=${persistence.storageStateValid}`
    );

    // ── Step 8: Verify auth state ────────────────────────────────────────────
    const verification: EbayResearchAuthInspection =
      await inspectEbayResearchAuthState(marketplace);
    const expectedSessionSource = getExpectedVerificationSessionSource(
      persistence.sessionStoreSelected
    );
    if (
      verification.authState !== 'loaded' ||
      verification.sessionSource !== expectedSessionSource ||
      verification.authValidationSucceeded !== true
    ) {
      throw new Error(
        `eBay Research session auto-renewal verification failed (authState=${verification.authState}, sessionSource=${verification.sessionSource ?? 'none'}, authValidationSucceeded=${verification.authValidationSucceeded}, cookieCount=${verification.cookieCount}).`
      );
    }

    // ── Step 9: Schedule alerts ──────────────────────────────────────────────
    const latestStoreResolution = createEbayResearchSessionStoreResolution(marketplace);
    const meta = latestStoreResolution.store ? await latestStoreResolution.store.getMeta() : null;

    if (typeof meta?.expiresAt === 'string' && typeof meta?.sessionVersion === 'string') {
      const scheduleResult = await scheduleEbayResearchSessionAlerts({
        marketplace,
        expiresAt: meta.expiresAt,
        sessionVersion: meta.sessionVersion,
      });

      console.log(
        `[EbayResearchSessionAlerts] schedule status=${scheduleResult.status} reason=${scheduleResult.reason ?? 'none'} callbackUrl=${scheduleResult.callbackUrl} entries=${scheduleResult.scheduled.length}`
      );
      for (const entry of scheduleResult.scheduled) {
        console.log(
          `[EbayResearchSessionAlerts] scheduled threshold=${entry.threshold} targetTime=${entry.targetTime} messageId=${entry.messageId ?? 'null'}`
        );
      }

      if (
        scheduleResult.status === 'skipped' &&
        alertingLooksConfigured() &&
        (scheduleResult.reason === 'shared_lock_backend_unavailable' ||
          scheduleResult.reason === 'callback_url_not_public' ||
          scheduleResult.reason === 'callback_url_invalid')
      ) {
        throw new Error(
          scheduleResult.reason === 'shared_lock_backend_unavailable'
            ? 'eBay Research session alerts require EBAY_RESEARCH_SESSION_STORE=upstash-redis or filesystem because the current backend cannot provide shared alert locks.'
            : 'eBay Research session alerts require a publicly reachable callback URL. Set PUBLIC_BASE_URL or EBAY_RESEARCH_SESSION_ALERT_CALLBACK_URL to an externally reachable URL before bootstrapping.'
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          marketplace,
          autoRenewed: true,
          persistedTo: persistence.sessionStoreSelected,
          storeTargetConnection: persistence.storeTargetConnection,
          storeCredentialsConfigured: persistence.storeCredentialsConfigured,
          canonicalKeys: {
            storageState: persistence.canonicalStateKey,
            metadata: persistence.canonicalMetaKey,
          },
          sessionMetadata: meta,
          validationPersistence,
          verification,
        },
        null,
        2
      )
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  const manualError =
    error instanceof ManualResearchSessionRequiredError
      ? {
          errorCode: error.errorCode,
          manualAction: error.manualAction,
          manualCaptureUrl: error.manualCaptureUrl,
          challengeType: error.challengeType,
          challengeUrl: error.challengeUrl,
        }
      : {};

  console.error(
    JSON.stringify(
      {
        ok: false,
        marketplace,
        autoRenewed: false,
        ...manualError,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
