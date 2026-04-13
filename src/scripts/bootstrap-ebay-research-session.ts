import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline';
import {
  clearEbayResearchAuthCache,
  type EbayResearchAuthInspection,
  inspectEbayResearchAuthState,
  inspectEbayResearchSessionPersistence,
  type ResearchStorageState,
  storeEbayResearchSessionToKv,
} from '../validation/providers/ebay-research.js';
import { loadChromium } from './playwright-runtime.js';

const configuredMarketplace = process.env.EBAY_RESEARCH_BOOTSTRAP_MARKETPLACE?.trim();
const marketplace =
  configuredMarketplace && configuredMarketplace.length > 0 ? configuredMarketplace : 'EBAY-US';
const researchUrl = `https://www.ebay.com/sh/research?marketplace=${encodeURIComponent(marketplace)}`;

function getChromiumChannel(): string | undefined {
  const configuredChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
  return configuredChannel && configuredChannel.length > 0 ? configuredChannel : undefined;
}

async function waitForEnter(promptText: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input, output });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: false,
    channel: getChromiumChannel(),
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Opening eBay Research bootstrap flow for marketplace ${marketplace}...`);
    await page.goto(researchUrl, { waitUntil: 'domcontentloaded' });

    await waitForEnter(
      'Sign in to eBay Research in the opened browser window, confirm the research UI is accessible, then press Enter to persist storage state to KV. '
    );

    await page.goto(researchUrl, { waitUntil: 'domcontentloaded' });
    if (!page.url().includes('/sh/research')) {
      throw new Error(
        `Research UI access could not be confirmed before persistence (currentUrl=${page.url()}).`
      );
    }

    const storageState = await context.storageState<ResearchStorageState>();
    const storageStateBytes = Buffer.byteLength(JSON.stringify(storageState), 'utf8');
    await storeEbayResearchSessionToKv(marketplace, storageState, 'storage_state');
    clearEbayResearchAuthCache();
    const persistence = await inspectEbayResearchSessionPersistence(marketplace);

    console.log(
      `[eBayResearchSessionBootstrap] Stored eBay Research storage state to ${persistence.sessionStoreSelected} (${storageStateBytes} bytes)`
    );

    const verification: EbayResearchAuthInspection =
      await inspectEbayResearchAuthState(marketplace);
    if (
      verification.authState !== 'loaded' ||
      verification.sessionSource !== persistence.sessionStoreSelected ||
      verification.authValidationSucceeded !== true
    ) {
      throw new Error(
        `eBay Research session bootstrap verification failed (authState=${verification.authState}, sessionSource=${verification.sessionSource ?? 'none'}, authValidationSucceeded=${verification.authValidationSucceeded}, cookieCount=${verification.cookieCount}).`
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          marketplace,
          persistedTo: persistence.sessionStoreSelected,
          canonicalKeys: {
            storageState: persistence.canonicalStateKey,
            metadata: persistence.canonicalMetaKey,
          },
          persistence,
          refreshCommand: 'pnpm run research:bootstrap',
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
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
