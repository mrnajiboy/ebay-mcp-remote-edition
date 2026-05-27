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
  solveCaptcha,
  injectCaptchaToken,
} from '../captcha/captcha.js';

const configuredMarketplace = process.env.EBAY_RESEARCH_BOOTSTRAP_MARKETPLACE?.trim();
const marketplace =
  configuredMarketplace && configuredMarketplace.length > 0 ? configuredMarketplace : 'EBAY-US';
// Used as the redirect target URL after login to confirm session access
const _researchUrl = `https://www.ebay.com/sh/research?marketplace=${encodeURIComponent(marketplace)}`;

const EBAY_SIGNIN_URL = 'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&UsingSSL=1';

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

/**
 * Detect and solve captcha challenges during auto-renewal.
 */
async function handleCaptchaChallenge(
  page: Parameters<typeof detectCaptcha>[0] & { url(): string }
): Promise<void> {
  const captchaType = await detectCaptcha(page);
  if (!captchaType) {
    return;
  }

  console.log(`[AutoRenew] Detected ${captchaType} challenge — attempting to solve...`);

  const siteKey = await extractSiteKey(page, captchaType);
  if (!siteKey) {
    console.warn(`[AutoRenew] Could not extract site key for ${captchaType} — skipping auto-solve`);
    return;
  }

  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey || apiKey.length < 1) {
    console.warn('[AutoRenew] TWOCAPTCHA_API_KEY not set — captcha requires manual solving');
    return;
  }

  try {
    const solution = await solveCaptcha({
      type: captchaType,
      siteKey,
      pageUrl: page.url(),
    });
    console.log(`[AutoRenew] Captcha solved — injecting token (${solution.token.length} chars)`);
    await injectCaptchaToken(page, captchaType, solution.token);
    console.log('[AutoRenew] Token injected successfully');
    // Give the page a moment to process the captcha token
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });
  } catch (error) {
    console.error(
      `[AutoRenew] Captcha solve failed: ${error instanceof Error ? error.message : String(error)}`
    );
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
 * Wait for an element to appear on the page with a timeout.
 */
async function waitForSelector(
  page: AnyPage,
  selector: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found: boolean = await (page as unknown as CaptchaPage).evaluate(
      (sel: string) => document.querySelector(sel) !== null,
      selector
    );
    if (found) return true;

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });
  }
  return false;
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
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });

    // Auto-solve captcha if encountered on the sign-in page
    await handleCaptchaChallenge(page as unknown as CaptchaPage & { url(): string });

    // ── Step 2: Fill username ────────────────────────────────────────────────
    console.log('[AutoRenew] Filling username...');

    // Try multiple possible selectors for the user ID field
    const userIdSelectors = [
      'input[name="userid"]',
      'input#userid',
      'input[data-testid="userid"]',
      'input[data-test-id="userid"]',
      'input[aria-label*="user" i]',
      'input[placeholder*="Email" i]',
      'input[placeholder*="user" i]',
    ];

    let userIdField = false;
    for (const sel of userIdSelectors) {
      userIdField = await waitForSelector(page, sel, 2000);
      if (userIdField) {
        await (page as unknown as CaptchaPage).evaluate(
          ({ selector, value }: { selector: string; value: string }) => {
            const el = document.querySelector<HTMLInputElement>(selector);
            if (el) {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          },
          { selector: sel, value: username }
        );
        console.log(`[AutoRenew] Filled username using selector: ${sel}`);
        break;
      }
    }

    if (!userIdField) {
      // Fallback: try to find ANY visible input field on the page
      console.log('[AutoRenew] Trying fallback — filling first visible text input...');
      await (page as unknown as CaptchaPage).evaluate((val: string) => {
        const inputs = document.querySelectorAll<HTMLInputElement>(
          'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"])'
        );
        for (const input of Array.from(inputs)) {
          if (input.offsetParent !== null) {
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          }
        }
      }, username);
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });

    // ── Step 3: Click Continue / Sign-in button ──────────────────────────────
    console.log('[AutoRenew] Clicking continue/sign-in button...');
    const continueSelectors = [
      'button#sgnBt',
      'button[data-testid="sgnBt"]',
      'button[type="submit"]',
      'input#sgnBt',
      'input[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Sign in")',
    ];

    let clickedSignIn = false;
    for (const sel of continueSelectors) {
      const found = await waitForSelector(page, sel, 2000);
      if (found) {
        await (page as unknown as CaptchaPage).evaluate((s: string) => {
          const el = document.querySelector<HTMLElement>(s);
          if (el) el.click();
        }, sel);
        console.log(`[AutoRenew] Clicked: ${sel}`);
        clickedSignIn = true;
        break;
      }
    }

    if (!clickedSignIn) {
      throw new Error(
        'Could not find sign-in/continue button on eBay sign-in page. ' +
          'The page structure may have changed. Manual bootstrap required.'
      );
    }

    // ── Step 4: Wait for password field (or research page if no password step) ──
    console.log('[AutoRenew] Waiting for password page or redirect...');

    // Wait a moment for the password page to load
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });

    // Check if we've been redirected to the research page already
    const currentUrl = page.url();
    if (currentUrl.includes('/sh/research')) {
      console.log('[AutoRenew] Already at research page — session may have been valid!');
    } else if (currentUrl.includes('signin.ebay.com') || currentUrl.includes('SignIn')) {
      // Still on sign-in page — need to fill password
      console.log('[AutoRenew] On password page — filling password...');

      // Auto-solve captcha if encountered
      await handleCaptchaChallenge(page as unknown as CaptchaPage & { url(): string });

      const passwordSelectors = [
        'input[name="pass"]',
        'input#pass',
        'input[data-testid="pass"]',
        'input[type="password"]',
      ];

      let passwordField = false;
      for (const sel of passwordSelectors) {
        passwordField = await waitForSelector(page, sel, 2000);
        if (passwordField) {
          await (page as unknown as CaptchaPage).evaluate(
            ({ selector, value }: { selector: string; value: string }) => {
              const el = document.querySelector<HTMLInputElement>(selector);
              if (el) {
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            },
            { selector: sel, value: password }
          );
          console.log(`[AutoRenew] Filled password using selector: ${sel}`);
          break;
        }
      }

      if (!passwordField) {
        throw new Error(
          'Could not find password field on eBay sign-in page. ' +
            'Auto-renewal requires manual inspection of the sign-in flow.'
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 500);
      });

      // Click sign-in submit
      console.log('[AutoRenew] Clicking sign-in submit...');
      const signInSelectors = [
        'button#sgnBt',
        'button[data-testid="sgnBt"]',
        'button[type="submit"]',
        'input#sgnBt',
        'input[type="submit"]',
      ];

      let clickedSubmit = false;
      for (const sel of signInSelectors) {
        const found = await waitForSelector(page, sel, 2000);
        if (found) {
          await (page as unknown as CaptchaPage).evaluate((s: string) => {
            const el = document.querySelector<HTMLElement>(s);
            if (el) el.click();
          }, sel);
          console.log(`[AutoRenew] Clicked sign-in: ${sel}`);
          clickedSubmit = true;
          break;
        }
      }

      if (!clickedSubmit) {
        throw new Error('Could not find sign-in submit button on eBay password page.');
      }
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
  console.error(
    JSON.stringify(
      {
        ok: false,
        marketplace,
        autoRenewed: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
