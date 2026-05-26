/**
 * Live integration test: captcha module against real hCaptcha
 */

import { chromium } from 'playwright-core';
import {
  detectCaptcha,
  extractSiteKey,
  solveCaptcha,
  injectCaptchaToken,
} from '../build/captcha/captcha.js';

async function main() {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) {
    console.error('TWOCAPTCHA_API_KEY not set');
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to eBay sign-in...');
    await page.goto('https://signin.ebay.com/ws/eBayISAPI.dll?SignIn', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    console.log('Final URL:', page.url());

    // If redirected to captcha page, wait for the hcaptcha iframe
    if (page.url().includes('/splashui/captcha')) {
      console.log('Redirected to captcha page — waiting for widget to load...');
      await page.waitForSelector('iframe[src*="hcaptcha.com"]', { timeout: 15000 });
      console.log('hCaptcha iframe detected');
    }

    await page.screenshot({ path: '/tmp/ebay-signin-before.png' });
    console.log('Screenshot saved: /tmp/ebay-signin-before.png');

    console.log('Detecting captcha...');
    const captchaType = await detectCaptcha(page);
    console.log('Captcha detection result:', captchaType ?? 'none found');

    if (!captchaType) {
      console.log('No captcha detected. Checking DOM...');
      const hasHcaptcha = await page.locator('.h-captcha').count() > 0;
      const hasRecaptcha = await page.locator('.g-recaptcha').count() > 0;
      console.log(`  h-captcha elements: ${hasHcaptcha ? 'YES' : 'NO'}`);
      console.log(`  g-recaptcha elements: ${hasRecaptcha ? 'YES' : 'NO'}`);
      await browser.close();
      console.log('\nTest complete — no captcha challenge triggered.');
      return;
    }

    console.log(`Extracting site key for ${captchaType}...`);
    const siteKey = await extractSiteKey(page, captchaType);
    console.log('Site key:', siteKey ?? 'NOT FOUND');

    if (!siteKey) {
      console.error('Could not extract site key — aborting');
      await browser.close();
      process.exit(1);
    }

    console.log('Solving captcha via 2Captcha...');
    const solution = await solveCaptcha({
      type: captchaType,
      siteKey,
      pageUrl: page.url(),
      timeout: 180000,  // 3 minutes for 2Captcha
    });
    console.log('Solution received:', solution ? `YES (token length: ${solution.token.length})` : 'NO');

    console.log('Injecting token...');
    await injectCaptchaToken(page, captchaType, solution.token);
    console.log('Token injected');

    await page.screenshot({ path: '/tmp/ebay-signin-after.png' });
    console.log('Screenshot saved: /tmp/ebay-signin-after.png');
    console.log('\n✅ Full captcha flow completed!');

  } catch (error) {
    console.error('\n❌ Error:', error);
    await page.screenshot({ path: '/tmp/ebay-signin-error.png' });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
