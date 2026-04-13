export interface PlaywrightLaunchOptions {
  headless: boolean;
  channel?: string;
}

export interface PlaywrightPageGotoOptions {
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
}

export interface PlaywrightPage {
  goto(url: string, options?: PlaywrightPageGotoOptions): Promise<unknown>;
  url(): string;
}

export interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  storageState<T = unknown>(): Promise<T>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightBrowserContext>;
  newPage(): Promise<PlaywrightPage>;
  version(): string;
  close(): Promise<void>;
}

export interface PlaywrightChromium {
  launch(options: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
}

interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

const PLAYWRIGHT_MODULE_NAME = 'playwright-core';

export async function loadChromium(): Promise<PlaywrightChromium> {
  const playwrightModule = (await import(PLAYWRIGHT_MODULE_NAME)) as PlaywrightModule;
  return playwrightModule.chromium;
}
