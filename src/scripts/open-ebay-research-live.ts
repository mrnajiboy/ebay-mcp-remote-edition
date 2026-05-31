import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, BrowserContextOptions } from 'playwright-core';
import type { ResearchStorageState } from '../validation/providers/ebay-research.js';
import { createFreshEbayResearchSessionStoreResolution } from '../validation/providers/ebay-research-session-store.js';

const RESEARCH_UI_URL = 'https://www.ebay.com/sh/research';
const DEFAULT_MARKETPLACE = 'EBAY-US';
const DEFAULT_STORAGE_STATE_PATH = '/tmp/ebay-research-live-storage-state.json';
const DEFAULT_PID_PATH = '/tmp/ebay-research-live.pid';

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : null;
}

function getChromiumChannel(): string | undefined {
  const channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
  return channel || undefined;
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildResearchUiUrl(options: {
  marketplace: string;
  query: string | null;
  validationId: string | null;
}): string {
  const url = new URL(RESEARCH_UI_URL);
  url.searchParams.set('marketplace', options.marketplace);
  if (options.query) url.searchParams.set('keywords', options.query);
  if (options.validationId) url.searchParams.set('validationId', options.validationId);
  return url.toString();
}

async function readPersistedStorageState(
  marketplace: string
): Promise<ResearchStorageState | undefined> {
  const explicitPath = process.env.EBAY_RESEARCH_LIVE_SEED_STORAGE_STATE_PATH?.trim();
  if (explicitPath) {
    const raw = await readFile(explicitPath, 'utf8');
    return JSON.parse(raw) as ResearchStorageState;
  }

  const resolution = createFreshEbayResearchSessionStoreResolution(marketplace);
  if (!resolution.store) return undefined;
  const raw = await resolution.store.getStorageState();
  if (!raw) return undefined;
  return JSON.parse(raw) as ResearchStorageState;
}

async function persistContextState(context: BrowserContext, outputPath: string): Promise<void> {
  const storageState = await context.storageState();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(storageState, null, 2), 'utf8');
}

async function main(): Promise<void> {
  const marketplace = (getArgValue('marketplace') || DEFAULT_MARKETPLACE).toUpperCase();
  const query = getArgValue('query');
  const validationId = getArgValue('validation-id');
  const outputPath = resolve(
    getArgValue('storage-state-path') ||
      process.env.EBAY_RESEARCH_LIVE_STORAGE_STATE_PATH ||
      DEFAULT_STORAGE_STATE_PATH
  );
  const pidPath = resolve(process.env.EBAY_RESEARCH_LIVE_PID_PATH || DEFAULT_PID_PATH);
  const persistIntervalMs = getPositiveIntegerEnv('EBAY_RESEARCH_LIVE_PERSIST_INTERVAL_MS', 5_000);
  const targetUrl = buildResearchUiUrl({ marketplace, query, validationId });
  const seedStorageState = await readPersistedStorageState(marketplace).catch((error: unknown) => {
    console.warn(
      `[ResearchLive] Could not load seed storage state: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  });

  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(process.pid), 'utf8');

  console.log(
    `[ResearchLive] Opening headed browser on DISPLAY=${process.env.DISPLAY ?? '(unset)'} marketplace=${marketplace} query=${query ?? '(none)'} validationId=${validationId ?? '(none)'} seedStorageState=${seedStorageState ? 'loaded' : 'missing'}`
  );

  const browser = await chromium.launch({
    headless: false,
    channel: getChromiumChannel(),
  });

  const contextOptions: BrowserContextOptions = {
    viewport: { width: 1440, height: 1000 },
  };
  if (seedStorageState) {
    contextOptions.storageState =
      seedStorageState as unknown as BrowserContextOptions['storageState'];
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await persistContextState(context, outputPath);

  const interval = setInterval(() => {
    persistContextState(context, outputPath).catch((error: unknown) => {
      console.warn(
        `[ResearchLive] Periodic storage-state persistence failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, persistIntervalMs);

  async function shutdown(signal: string): Promise<void> {
    clearInterval(interval);
    console.log(`[ResearchLive] ${signal} received; persisting storage state and closing browser.`);
    await persistContextState(context, outputPath).catch((error: unknown) => {
      console.warn(
        `[ResearchLive] Final storage-state persistence failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    await browser.close().catch(() => undefined);
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  console.log(`[ResearchLive] Browser ready. Storage state will be mirrored to ${outputPath}`);
  await new Promise<void>(() => {
    // Keep the process alive until SIGINT/SIGTERM closes the browser.
  });
}

main().catch((error) => {
  console.error(
    '[ResearchLive] Failed:',
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exit(1);
});
