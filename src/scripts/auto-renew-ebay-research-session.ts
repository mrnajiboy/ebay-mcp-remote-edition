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

// Strategy type for field finding
interface FieldStrategy {
  name?: string;
  id?: string;
  type?: string;
  placeholderPattern?: string;
  ariaLabelPattern?: string;
  testId?: string;
  attribute?: { key: string; value: string };
}

/**
 * Dump visible form inputs across ALL frames (main + iframes) for debugging.
 */
async function dumpVisibleInputs(page: AnyPage, label: string): Promise<void> {
  const allFrames = getAllFrames(page);
  const results: string[] = [];

  for (const frame of allFrames) {
    try {
      const frameUrl = frame.url?.() ?? 'unknown';
      const shortUrl = frameUrl.length > 80 ? frameUrl.substring(0, 80) + '…' : frameUrl;
      const fields = await frame.evaluate(() => {
        const inputs = [];
        for (const el of document.querySelectorAll<HTMLInputElement>('input')) {
          if (el.type === 'hidden') continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          inputs.push(
            `[${el.type}] id=${el.id} name=${el.name} placeholder="${el.placeholder}" ` +
              `aria-label="${el.getAttribute('aria-label') ?? ''}" ` +
              `data-testid="${el.getAttribute('data-testid') ?? ''}"`
          );
        }
        return inputs;
      });
      if (fields.length > 0) {
        results.push(`[${shortUrl}] ${JSON.stringify(fields)}`);
      }
    } catch {
      // Cross-origin frame — skip
    }
  }

  if (results.length > 0) {
    console.warn(`[AutoRenew] ${label}: ${results.join('\n')}`);
  } else {
    console.warn(
      `[AutoRenew] ${label}: No visible inputs found across ${allFrames.length} frame(s).`
    );
  }

  // Also dump frame list for context
  const frameList = allFrames.map((f: AnyPage) => {
    const url = f.url?.() ?? 'unknown';
    return url.length > 100 ? url.substring(0, 100) + '…' : url;
  });
  console.warn(`[AutoRenew] Frames: ${JSON.stringify(frameList)}`);
}

/**
 * Get all frames (main + child iframes) from a Playwright page.
 */
function getAllFrames(page: AnyPage): AnyPage[] {
  const frames = page.frames;
  if (Array.isArray(frames)) {
    // Filter out detached/blank frames
    return frames.filter((f: AnyPage) => {
      const url = f.url?.() ?? '';
      return url && !url.startsWith('about:blank') && !url.startsWith('devtools://');
    });
  }
  return [page];
}

/**
 * Build a CSS selector from a strategy for Playwright locator.
 */
function buildInputSelector(strat: Record<string, unknown>): string | null {
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
 * Find a matching visible input in a single frame using Playwright locator.
 * Returns { frame, elementHandle } or null.
 */
async function findInputInFrame(
  frame: AnyPage,
  strat: Record<string, unknown>
): Promise<{ frame: AnyPage; selector: string } | null> {
  const selector = buildInputSelector(strat);
  if (!selector) return null;

  try {
    const locator = frame.locator(selector);
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      const isVisible = await el.isVisible().catch(() => false);
      if (!isVisible) continue;

      // Verify via DOM that it matches all strategy criteria
      const domOk = await frame
        .evaluate((sel: string) => {
          const input = document.querySelector<HTMLElement>(sel);
          if (!input) return false;
          const style = window.getComputedStyle(input);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (input.getAttribute('type') === 'hidden') return false;
          return true;
        }, selector)
        .catch(() => false);

      if (domOk) {
        return { frame, selector };
      }
    }
  } catch {
    // Frame may be cross-origin or not ready
  }
  return null;
}

/**
 * Find a VISIBLE form input matching a given strategy across ALL frames (main + iframes).
 * Strategies: name, id, attribute, placeholder, aria-label, type, test-id.
 * Falls back to placeholder/aria-label pattern matching via DOM evaluation.
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
): Promise<{ frame: AnyPage; selector: string } | null> {
  const allFrames = getAllFrames(page);

  // Try each frame
  for (const frame of allFrames) {
    const result = await findInputInFrame(frame, strategy);
    if (result) return result;
  }

  // Fallback: pattern-based search (placeholder, aria-label) across all frames
  if (strategy.placeholderPattern || strategy.ariaLabelPattern || strategy.type) {
    for (const frame of allFrames) {
      try {
        const found = await frame.evaluate((strat: FieldStrategy) => {
          const inputs = document.querySelectorAll<HTMLInputElement>('input');
          for (const input of Array.from(inputs)) {
            if (input.type === 'hidden' || input.type === 'submit' || input.type === 'checkbox') {
              continue;
            }
            const style = window.getComputedStyle(input);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (strat.type && input.type !== strat.type) continue;
            if (strat.placeholderPattern && input.placeholder) {
              if (
                input.placeholder.toLowerCase().includes(strat.placeholderPattern.toLowerCase())
              ) {
                return input;
              }
            }
            if (strat.ariaLabelPattern && input.getAttribute('aria-label')) {
              if (
                input
                  .getAttribute('aria-label')!
                  .toLowerCase()
                  .includes(strat.ariaLabelPattern.toLowerCase())
              ) {
                return input;
              }
            }
            if (strat.testId) {
              const tid =
                input.getAttribute('data-testid') ||
                input.getAttribute('data-test-id') ||
                input.getAttribute('data-playwright-test-trigger-id');
              if (tid?.toLowerCase() === strat.testId.toLowerCase()) {
                return input;
              }
            }
            if (
              strat.attribute &&
              input.getAttribute(strat.attribute.key) === strat.attribute?.value
            ) {
              return input;
            }
          }
          return null;
        }, strategy);
        if (found) {
          // Use a unique attribute to identify the element
          const attrs = await frame.evaluate((strat: FieldStrategy) => {
            const inputs = document.querySelectorAll<HTMLInputElement>('input');
            for (const input of Array.from(inputs)) {
              if (input.type === 'hidden' || input.type === 'submit' || input.type === 'checkbox')
                continue;
              const style = window.getComputedStyle(input);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              let match = false;
              if (strat.type && input.type === strat.type) match = true;
              if (strat.placeholderPattern && input.placeholder) {
                if (
                  input.placeholder.toLowerCase().includes(strat.placeholderPattern.toLowerCase())
                ) {
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
              if (match) {
                return {
                  id: input.id || null,
                  name: input.name || null,
                  type: input.type || null,
                  placeholder: input.placeholder || null,
                  ariaLabel: input.getAttribute('aria-label') || null,
                  testId:
                    input.getAttribute('data-testid') ||
                    input.getAttribute('data-test-id') ||
                    input.getAttribute('data-playwright-test-trigger-id') ||
                    null,
                };
              }
            }
            return null;
          }, strategy);
          if (attrs) {
            // Build selector from attrs
            let sel: string | null = null;
            if (attrs.id) sel = `input#${attrs.id}`;
            else if (attrs.name) sel = `input[name="${attrs.name}"]`;
            else if (attrs.placeholder) sel = `input[placeholder="${attrs.placeholder}"]`;
            else if (attrs.ariaLabel) sel = `input[aria-label="${attrs.ariaLabel}"]`;
            else if (attrs.testId) sel = `[data-testid="${attrs.testId}"]`;
            else if (attrs.type) sel = `input[type="${attrs.type}"]`;
            if (sel) return { frame, selector: sel };
          }
        }
      } catch {
        // Cross-origin frame
      }
    }
  }

  return null;
}

/**
 * Find a VISIBLE button matching text content or selector across all frames.
 */
async function findVisibleButton(
  page: AnyPage,
  labelPattern: string
): Promise<{ frame: AnyPage; selector: string; text: string } | null> {
  const allFrames = getAllFrames(page);

  for (const frame of allFrames) {
    // Try Playwright getByRole first
    try {
      const locator = frame.getByRole('button', { name: labelPattern, exact: false });
      const count = await locator.count();
      if (count > 0) {
        const el = locator.first();
        const isVisible = await el.isVisible().catch(() => false);
        if (isVisible) {
          const text = await el.textContent().catch(() => '');
          const selector = await el
            .evaluate((el: HTMLElement) => {
              if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
              if (el.className && typeof el.className === 'string') {
                return `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}`;
              }
              return el.tagName.toLowerCase();
            })
            .catch(() => 'button');
          return { frame, selector: selector as string, text: text?.trim() || labelPattern };
        }
      }
    } catch {
      // getByRole not available
    }

    // DOM-based fallback within frame
    try {
      const found = await frame.evaluate((pattern: string) => {
        const buttons = document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], [role="button"]'
        );
        for (const btn of Array.from(buttons)) {
          const style = window.getComputedStyle(btn);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const text = `${btn.innerText ?? ''} ${(btn as HTMLInputElement).value ?? ''}`.trim();
          if (text.toLowerCase().includes(pattern.toLowerCase())) {
            return {
              text,
              id: btn.id || null,
              tagName: btn.tagName,
              className: btn.className || '',
            };
          }
        }
        return null;
      }, labelPattern);
      if (found) {
        let sel = 'button';
        if (found.id) sel = `${found.tagName.toLowerCase()}#${found.id}`;
        return { frame, selector: sel, text: found.text };
      }
    } catch {
      // Cross-origin frame
    }
  }

  return null;
}

/**
 * Fill a form field by trying multiple strategies in order.
 * Searches across ALL frames (main + iframes) and fills in the correct frame.
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
    const result = await findVisibleInput(page, strat);
    if (result) {
      const { frame, selector } = result;
      const stratDesc = JSON.stringify(strat);

      // Fill using Playwright's frame-aware locator.fill()
      try {
        await frame.locator(selector).first().fill(value);
        return stratDesc;
      } catch (e) {
        console.warn(
          `[AutoRenew] frame.locator.fill failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      // Fallback: DOM-based fill in the correct frame
      try {
        await frame.evaluate(
          (sel: string, val: string) => {
            const input = document.querySelector<HTMLElement>(sel) as HTMLInputElement | null;
            if (input?.tagName === 'INPUT') {
              input.focus();
              input.value = val;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          selector,
          value
        );
        return stratDesc;
      } catch (e) {
        console.warn(
          `[AutoRenew] frame.evaluate fill failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      // Last resort: clear and type
      try {
        await frame.locator(selector).first().click();
        await frame.locator(selector).first().press('Control+a');
        await frame.locator(selector).first().press('Backspace');
        await frame.locator(selector).first().fill(value);
        return stratDesc;
      } catch {
        // skip
      }
    }
  }
  return null;
}

/**
 * Click a button by trying text content matching across all frames, then CSS selectors.
 */
async function clickButton(page: AnyPage, labelPatterns: string[]): Promise<string | null> {
  // Try Playwright native click on main page first
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

  // Use frame-aware findVisibleButton
  for (const pattern of labelPatterns) {
    const btnResult = await findVisibleButton(page, pattern);
    if (btnResult) {
      const { frame, selector } = btnResult;
      // Try Playwright click in the correct frame
      try {
        await frame.locator(selector).first().click();
        return `button "${pattern}" (selector: ${selector})`;
      } catch {
        // Fallback: DOM click in frame
        try {
          await frame.evaluate((sel: string) => {
            const el = document.querySelector<HTMLElement>(sel);
            if (el) el.click();
          }, selector);
          return `button "${pattern}" (DOM click)`;
        } catch {
          // skip
        }
      }
    }
  }

  // Try classic CSS selectors across all frames as last resort
  const allFrames = getAllFrames(page);
  const classicSelectors = [
    '#signin-continue-btn',
    'button#signin-continue-btn',
    '#sgnBt',
    'button#sgnBt',
    'button[type="submit"]',
    'input[type="submit"]',
  ];
  for (const frame of allFrames) {
    for (const sel of classicSelectors) {
      try {
        await frame.locator(sel).first().click();
        return sel;
      } catch {
        // skip
      }
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
      // Debug: dump all visible inputs across all frames
      console.warn('[AutoRenew] Username field not found. Dumping visible form fields...');
      await dumpVisibleInputs(page, 'Username inputs dump');

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
        // Debug: dump all visible inputs across all frames
        console.warn('[AutoRenew] Password field not found. Dumping visible form fields...');
        await dumpVisibleInputs(page, 'Password inputs dump');

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
      // Dump visible inputs across all frames for debugging
      await dumpVisibleInputs(page, 'Unexpected page inputs dump');

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
