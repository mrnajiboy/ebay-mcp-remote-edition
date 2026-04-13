declare const process: {
  env: Record<string, string | undefined>;
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const axiosGetMock = vi.fn();
const kvGetMock = vi.fn();
const kvPutMock = vi.fn();
const kvDeleteMock = vi.fn();
const existsSyncMock = vi.fn<(path?: string) => boolean>(() => false);
const readFileMock = vi.fn();
const browserCloseMock = vi.fn();
const browserNewContextMock = vi.fn();
const browserContextCloseMock = vi.fn();
const browserContextCookiesMock = vi.fn();
const browserContextStorageStateMock = vi.fn();
const persistentContextCookiesMock = vi.fn();
const persistentContextStorageStateMock = vi.fn();
const persistentContextCloseMock = vi.fn();
const chromiumLaunchMock = vi.fn();
const chromiumLaunchPersistentContextMock = vi.fn();

vi.mock('axios', () => ({
  default: {
    get: axiosGetMock,
  },
  isAxiosError: () => false,
}));

vi.mock('@/auth/kv-store.js', () => ({
  createKVStore: () => ({
    backendName: 'memory',
    get: kvGetMock,
    put: kvPutMock,
    delete: kvDeleteMock,
  }),
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

vi.mock('playwright-core', () => ({
  chromium: {
    launch: chromiumLaunchMock,
    launchPersistentContext: chromiumLaunchPersistentContextMock,
  },
}));

function buildActivePayload(): string {
  return JSON.stringify({
    _type: 'ActiveSearchResultsModule',
    results: [
      {
        listing: {
          title: 'ATEEZ GOLDEN HOUR active',
          itemId: { value: 'active-1' },
        },
        listingPrice: {
          listingPrice: '$10.00',
          listingShipping: '$2.00',
        },
        watchers: '3',
        promoted: true,
        startDate: '2026-04-01T00:00:00.000Z',
      },
    ],
  });
}

function buildSoldPayload(): string {
  return JSON.stringify({
    _type: 'SearchResultsModule',
    results: [
      {
        listing: {
          title: 'ATEEZ GOLDEN HOUR sold',
          itemId: { value: 'sold-1' },
        },
        avgsalesprice: {
          avgsalesprice: '$12.00',
        },
        avgshipping: {
          avgshipping: '$1.00',
        },
        itemssold: '2',
        totalsales: '$24.00',
        datelastsold: '2026-04-10T00:00:00.000Z',
      },
    ],
  });
}

describe('fetchEbayResearch()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T00:00:00.000Z'));
    axiosGetMock.mockReset();
    kvGetMock.mockReset();
    kvPutMock.mockReset();
    kvDeleteMock.mockReset();
    existsSyncMock.mockReset();
    readFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    kvGetMock.mockResolvedValue(null);
    kvPutMock.mockResolvedValue(undefined);
    kvDeleteMock.mockResolvedValue(undefined);
    browserCloseMock.mockReset();
    browserNewContextMock.mockReset();
    browserContextCloseMock.mockReset();
    browserContextCookiesMock.mockReset();
    browserContextStorageStateMock.mockReset();
    persistentContextCookiesMock.mockReset();
    persistentContextStorageStateMock.mockReset();
    persistentContextCloseMock.mockReset();
    chromiumLaunchMock.mockReset();
    chromiumLaunchPersistentContextMock.mockReset();
    browserCloseMock.mockResolvedValue(undefined);
    browserContextCloseMock.mockResolvedValue(undefined);
    browserContextCookiesMock.mockImplementation(async () => [
      { name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' },
    ]);
    browserContextStorageStateMock.mockImplementation(async () => ({
      cookies: [{ name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' }],
      origins: [],
    }));
    browserNewContextMock.mockResolvedValue({
      cookies: browserContextCookiesMock,
      storageState: browserContextStorageStateMock,
      close: browserContextCloseMock,
    });
    chromiumLaunchMock.mockResolvedValue({
      newContext: browserNewContextMock,
      close: browserCloseMock,
    });
    persistentContextCookiesMock.mockResolvedValue([
      { name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' },
    ]);
    persistentContextStorageStateMock.mockResolvedValue({
      cookies: [{ name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' }],
      origins: [],
    });
    persistentContextCloseMock.mockResolvedValue(undefined);
    chromiumLaunchPersistentContextMock.mockResolvedValue({
      cookies: persistentContextCookiesMock,
      storageState: persistentContextStorageStateMock,
      close: persistentContextCloseMock,
    });
    delete process.env.EBAY_RESEARCH_STORAGE_STATE_PATH;
    delete process.env.EBAY_RESEARCH_PROFILE_DIR;
    delete process.env.EBAY_RESEARCH_STORAGE_STATE_JSON;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.EBAY_RESEARCH_COOKIES_JSON;
    delete process.env.EBAY_RESEARCH_STORAGE_STATE_JSON;
  });

  it('re-fetches research tabs when the authenticated cookie set changes', async () => {
    process.env.EBAY_RESEARCH_COOKIES_JSON = JSON.stringify([
      { name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' },
    ]);

    const { fetchEbayResearch } = await import('../../../src/validation/providers/ebay-research.js');

    axiosGetMock
      .mockResolvedValueOnce({ status: 200, data: buildActivePayload() })
      .mockResolvedValueOnce({ status: 200, data: buildSoldPayload() });

    await fetchEbayResearch('ATEEZ GOLDEN HOUR');
    expect(axiosGetMock).toHaveBeenCalledTimes(2);

    axiosGetMock.mockClear();
    vi.advanceTimersByTime(6 * 60 * 1000);
    process.env.EBAY_RESEARCH_COOKIES_JSON = JSON.stringify([
      { name: 'sid', value: 'cookie-b', domain: '.ebay.com', path: '/' },
    ]);

    axiosGetMock
      .mockResolvedValueOnce({ status: 200, data: buildActivePayload() })
      .mockResolvedValueOnce({ status: 200, data: buildSoldPayload() });

    await fetchEbayResearch('ATEEZ GOLDEN HOUR');
    expect(axiosGetMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache transient non-2xx research responses', async () => {
    process.env.EBAY_RESEARCH_COOKIES_JSON = JSON.stringify([
      { name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' },
    ]);

    const { fetchEbayResearch } = await import('../../../src/validation/providers/ebay-research.js');

    axiosGetMock
      .mockResolvedValueOnce({
        status: 429,
        data: JSON.stringify({ _type: 'PageErrorModule', message: 'Rate limited' }),
      })
      .mockResolvedValueOnce({
        status: 429,
        data: JSON.stringify({ _type: 'PageErrorModule', message: 'Rate limited' }),
      });

    await expect(fetchEbayResearch('ATEEZ GOLDEN HOUR')).rejects.toThrow(
      'eBay Research response did not include useful ACTIVE or SOLD modules after parsing.'
    );

    axiosGetMock.mockClear();
    axiosGetMock
      .mockResolvedValueOnce({ status: 200, data: buildActivePayload() })
      .mockResolvedValueOnce({ status: 200, data: buildSoldPayload() });

    const response = await fetchEbayResearch('ATEEZ GOLDEN HOUR');

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(response.active.listingRows).toHaveLength(1);
    expect(response.sold.soldRows).toHaveLength(1);
  });

  it('invalidates a rejected KV session so later auth sources can be used', async () => {
    kvGetMock
      .mockResolvedValueOnce({
        cookies: [{ name: 'sid', value: 'cookie-a', domain: '.ebay.com', path: '/' }],
        updatedAt: '2026-04-10T00:00:00.000Z',
        expiresAt: null,
        marketplace: 'EBAY-US',
        source: 'kv_store',
      })
      .mockResolvedValueOnce(null);

    const { fetchEbayResearch } = await import('../../../src/validation/providers/ebay-research.js');

    axiosGetMock
      .mockResolvedValueOnce({
        status: 403,
        data: JSON.stringify({ _type: 'PageErrorModule', message: 'Forbidden' }),
      })
      .mockResolvedValueOnce({
        status: 403,
        data: JSON.stringify({ _type: 'PageErrorModule', message: 'Forbidden' }),
      });

    const firstResponse = await fetchEbayResearch('ATEEZ GOLDEN HOUR');

    expect(firstResponse.debug.authState).toBe('expired');
    expect(firstResponse.debug.sessionStrategy).toBe('kv_store');
    expect(firstResponse.debug.sessionSource).toBe('kv');
    expect(kvDeleteMock.mock.calls.length).toBeGreaterThan(0);

    existsSyncMock.mockImplementation((path?: string) =>
      typeof path === 'string' && path.includes('.ebay-research/storage-state.json')
    );
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        cookies: [{ name: 'sid', value: 'cookie-b', domain: '.ebay.com', path: '/' }],
      })
    );
    axiosGetMock.mockResolvedValueOnce({ status: 200, data: buildActivePayload() }).mockResolvedValueOnce({
      status: 200,
      data: buildSoldPayload(),
    });

    const secondResponse = await fetchEbayResearch('ATEEZ GOLDEN HOUR');

    expect(secondResponse.debug.sessionStrategy).toBe('storage_state');
    expect(secondResponse.debug.sessionSource).toBe('filesystem');
    expect(secondResponse.debug.filesystemLoadSucceeded).toBe(true);
    expect(secondResponse.active.listingRows).toHaveLength(1);
    expect(secondResponse.sold.soldRows).toHaveLength(1);
  });

  it('prefers KV-backed storage state over environment cookie fallbacks', async () => {
    process.env.EBAY_RESEARCH_COOKIES_JSON = JSON.stringify([
      { name: 'sid', value: 'cookie-env', domain: '.ebay.com', path: '/' },
    ]);
    kvGetMock.mockResolvedValue({
      cookies: [{ name: 'sid', value: 'cookie-kv', domain: '.ebay.com', path: '/' }],
      storageState: {
        cookies: [{ name: 'sid', value: 'cookie-kv', domain: '.ebay.com', path: '/' }],
        origins: [],
      },
      updatedAt: '2026-04-10T00:00:00.000Z',
      expiresAt: null,
      marketplace: 'EBAY-US',
      source: 'storage_state',
      sessionSource: 'kv',
    });
    browserContextCookiesMock.mockResolvedValueOnce([
      { name: 'sid', value: 'cookie-kv', domain: '.ebay.com', path: '/' },
    ]);
    browserContextStorageStateMock.mockResolvedValueOnce({
      cookies: [{ name: 'sid', value: 'cookie-kv', domain: '.ebay.com', path: '/' }],
      origins: [],
    });

    const { fetchEbayResearch } = await import('../../../src/validation/providers/ebay-research.js');

    axiosGetMock
      .mockResolvedValueOnce({ status: 200, data: buildActivePayload() })
      .mockResolvedValueOnce({ status: 200, data: buildSoldPayload() });

    const response = await fetchEbayResearch('ATEEZ GOLDEN HOUR');

    expect(response.debug.sessionStrategy).toBe('storage_state');
    expect(response.debug.sessionSource).toBe('kv');
    expect(response.debug.kvLoadAttempted).toBe(true);
    expect(response.debug.kvLoadSucceeded).toBe(true);
    expect(response.debug.envLoadAttempted).toBe(false);
    expect(axiosGetMock.mock.calls[0]?.[1]?.headers?.cookie).toContain('cookie-kv');
    expect(axiosGetMock.mock.calls[0]?.[1]?.headers?.cookie).not.toContain('cookie-env');
  });

  it('keeps auth cache scoped per marketplace', async () => {
    kvGetMock.mockImplementation(async (key?: string) => {
      if (typeof key !== 'string') {
        return null;
      }

      if (key.endsWith(':EBAY-US')) {
        return {
          cookies: [{ name: 'sid', value: 'cookie-us', domain: '.ebay.com', path: '/' }],
          storageState: {
            cookies: [{ name: 'sid', value: 'cookie-us', domain: '.ebay.com', path: '/' }],
            origins: [],
          },
          updatedAt: '2026-04-10T00:00:00.000Z',
          expiresAt: null,
          marketplace: 'EBAY-US',
          source: 'storage_state',
          sessionSource: 'kv',
        };
      }

      if (key.endsWith(':EBAY-GB')) {
        return {
          cookies: [{ name: 'sid', value: 'cookie-gb', domain: '.ebay.com', path: '/' }],
          storageState: {
            cookies: [{ name: 'sid', value: 'cookie-gb', domain: '.ebay.com', path: '/' }],
            origins: [],
          },
          updatedAt: '2026-04-10T00:00:00.000Z',
          expiresAt: null,
          marketplace: 'EBAY-GB',
          source: 'storage_state',
          sessionSource: 'kv',
        };
      }

      return null;
    });

    browserContextCookiesMock
      .mockResolvedValueOnce([{ name: 'sid', value: 'cookie-us', domain: '.ebay.com', path: '/' }])
      .mockResolvedValueOnce([{ name: 'sid', value: 'cookie-gb', domain: '.ebay.com', path: '/' }]);
    browserContextStorageStateMock
      .mockResolvedValueOnce({
        cookies: [{ name: 'sid', value: 'cookie-us', domain: '.ebay.com', path: '/' }],
        origins: [],
      })
      .mockResolvedValueOnce({
        cookies: [{ name: 'sid', value: 'cookie-gb', domain: '.ebay.com', path: '/' }],
        origins: [],
      });

    const { inspectEbayResearchAuthState } = await import(
      '../../../src/validation/providers/ebay-research.js'
    );

    const usInspection = await inspectEbayResearchAuthState('EBAY-US');
    const gbInspection = await inspectEbayResearchAuthState('EBAY-GB');

    expect(usInspection.cookieCount).toBe(1);
    expect(gbInspection.cookieCount).toBe(1);
    expect(kvGetMock).toHaveBeenCalledTimes(2);
    expect(browserContextCookiesMock).toHaveBeenNthCalledWith(1, 'https://www.ebay.com');
    expect(browserContextCookiesMock).toHaveBeenNthCalledWith(2, 'https://www.ebay.com');
  });

  it('sanitizes non-ebay storage-state artifacts before persisting to KV', async () => {
    const { storeEbayResearchSessionToKv } = await import(
      '../../../src/validation/providers/ebay-research.js'
    );

    await storeEbayResearchSessionToKv(
      'EBAY-US',
      {
        cookies: [
          { name: 'sid', value: 'cookie-ebay', domain: '.ebay.com', path: '/' },
          { name: 'google', value: 'cookie-google', domain: '.google.com', path: '/' },
        ],
        origins: [
          {
            origin: 'https://www.ebay.com',
            localStorage: [{ name: 'ebay-key', value: 'ebay-value' }],
          },
          {
            origin: 'https://accounts.google.com',
            localStorage: [{ name: 'google-key', value: 'google-value' }],
          },
        ],
      },
      'storage_state'
    );

    expect(kvPutMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cookies: [{ name: 'sid', value: 'cookie-ebay', domain: '.ebay.com', path: '/' }],
        storageState: {
          cookies: [{ name: 'sid', value: 'cookie-ebay', domain: '.ebay.com', path: '/' }],
          origins: [
            {
              origin: 'https://www.ebay.com',
              localStorage: [{ name: 'ebay-key', value: 'ebay-value' }],
            },
          ],
        },
      }),
      expect.any(Number)
    );
  });

  it('rejects storage-state bootstrap payloads when no usable ebay cookies remain after sanitization', async () => {
    const { storeEbayResearchSessionToKv } = await import(
      '../../../src/validation/providers/ebay-research.js'
    );

    await expect(
      storeEbayResearchSessionToKv(
        'EBAY-US',
        {
          cookies: [{ name: 'google', value: 'cookie-google', domain: '.google.com', path: '/' }],
          origins: [
            {
              origin: 'https://accounts.google.com',
              localStorage: [{ name: 'google-key', value: 'google-value' }],
            },
          ],
        },
        'storage_state'
      )
    ).rejects.toThrow('Provided eBay Research storage state did not contain any usable cookies.');

    expect(kvPutMock).not.toHaveBeenCalled();
  });
});
