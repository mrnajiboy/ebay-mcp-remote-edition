import { loadChromium } from './playwright-runtime.js';

function getChromiumChannel(): string | undefined {
  const configuredChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
  return configuredChannel && configuredChannel.length > 0 ? configuredChannel : undefined;
}

async function main(): Promise<void> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: true,
    channel: getChromiumChannel(),
  });

  try {
    const page = await browser.newPage();
    await page.goto('about:blank');

    console.log(
      JSON.stringify(
        {
          ok: true,
          browserVersion: browser.version(),
          pageUrl: page.url(),
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
