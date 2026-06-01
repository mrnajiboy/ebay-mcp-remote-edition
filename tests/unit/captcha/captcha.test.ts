import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  solveCaptcha,
  detectCaptcha,
  extractSiteKey,
  injectCaptchaToken,
  triggerCaptchaVerification,
  waitForAndSolveCaptcha,
} from '@/captcha/captcha.js';
import type { CaptchaPage } from '@/captcha/captcha.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Captcha Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // Clear captcha env vars
    delete process.env.TWOCAPTCHA_API_KEY;
  });

  describe('solveCaptcha', () => {
    it('throws when no provider configured', async () => {
      await expect(
        solveCaptcha({
          type: 'hcaptcha',
          siteKey: 'test',
          pageUrl: 'http://test.com',
        })
      ).rejects.toThrow('No captcha solver configured');
    });

    it('solves via 2Captcha when configured (JSON response)', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      // Mock 2Captcha: create task → get result (JSON format)
      mockFetch
        .mockResolvedValueOnce({
          text: () => Promise.resolve(JSON.stringify({ status: 1, request: 'task-123' })),
        })
        .mockResolvedValueOnce({
          text: () => Promise.resolve(JSON.stringify({ status: 1, request: 'solution-token' })),
        });

      const result = await solveCaptcha(
        {
          type: 'hcaptcha',
          siteKey: 'test-site-key',
          pageUrl: 'http://test.com',
        },
        { pollIntervalMs: 100, maxWaitMs: 5000 }
      );

      expect(result.token).toBe('solution-token');
      expect(result.provider).toBe('twocaptcha');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('solves via 2Captcha when configured (plaintext OK|taskId)', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      // Mock 2Captcha: create task → get result (plaintext format)
      mockFetch
        .mockResolvedValueOnce({
          text: () => Promise.resolve('OK|54321'),
        })
        .mockResolvedValueOnce({
          text: () => Promise.resolve('OK|plaintext-solution'),
        });

      const result = await solveCaptcha(
        {
          type: 'hcaptcha',
          siteKey: 'test-site-key',
          pageUrl: 'http://test.com',
        },
        { pollIntervalMs: 100, maxWaitMs: 5000 }
      );

      expect(result.token).toBe('plaintext-solution');
      expect(result.provider).toBe('twocaptcha');
    });

    it('throws on timeout when captcha not solved', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      // 2Captcha: create task succeeds, then keep returning CAPCHA_NOT_READY until timeout
      mockFetch.mockImplementation(async () => {
        if (mockFetch.mock.calls.length === 1) {
          return {
            text: () => Promise.resolve(JSON.stringify({ status: 1, request: 'task-123' })),
          };
        }
        // Poll: always return still processing
        return { text: () => Promise.resolve(JSON.stringify({ status: 0, request: null })) };
      });

      await expect(
        solveCaptcha(
          {
            type: 'hcaptcha',
            siteKey: 'test-site-key',
            pageUrl: 'http://test.com',
          },
          { pollIntervalMs: 50, maxWaitMs: 200 }
        )
      ).rejects.toThrow(/timed out/);
    });

    it('throws aggregated error on API error', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      // 2Captcha: API error (plaintext format)
      mockFetch.mockResolvedValueOnce({
        text: () => Promise.resolve('ERROR_CAPTCHA_UNSOLVABLE'),
      });

      await expect(
        solveCaptcha({
          type: 'hcaptcha',
          siteKey: 'test',
          pageUrl: 'http://test.com',
        })
      ).rejects.toThrow();
    });
  });

  describe('detectCaptcha', () => {
    it('detects hCaptcha iframe', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue('hcaptcha'),
      };

      const result = await detectCaptcha(mockPage);
      expect(result).toBe('hcaptcha');
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('detects reCAPTCHA v2', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue('recaptcha_v2'),
      };

      const result = await detectCaptcha(mockPage);
      expect(result).toBe('recaptcha_v2');
    });

    it('detects reCAPTCHA v3', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue('recaptcha_v3'),
      };

      const result = await detectCaptcha(mockPage);
      expect(result).toBe('recaptcha_v3');
    });

    it('returns null when no captcha detected', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue(null),
      };

      const result = await detectCaptcha(mockPage);
      expect(result).toBeNull();
    });
  });

  describe('extractSiteKey', () => {
    it('extracts hCaptcha site key', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue('test-hcaptcha-key'),
      };

      const result = await extractSiteKey(mockPage, 'hcaptcha');
      expect(result).toBe('test-hcaptcha-key');
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function), 'hcaptcha');
    });

    it('extracts reCAPTCHA site key', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue('test-recaptcha-key'),
      };

      const result = await extractSiteKey(mockPage, 'recaptcha_v2');
      expect(result).toBe('test-recaptcha-key');
    });

    it('returns null when site key not found', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue(null),
      };

      const result = await extractSiteKey(mockPage, 'hcaptcha');
      expect(result).toBeNull();
    });
  });

  describe('injectCaptchaToken', () => {
    it('injects hCaptcha token into textarea', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      };

      await injectCaptchaToken(mockPage, 'hcaptcha', 'test-token');
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('injects reCAPTCHA v2 token', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      };

      await injectCaptchaToken(mockPage, 'recaptcha_v2', 'test-token');
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('injects reCAPTCHA v3 token', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      };

      await injectCaptchaToken(mockPage, 'recaptcha_v3', 'test-token');
      expect(mockPage.evaluate).toHaveBeenCalled();
    });
  });

  describe('triggerCaptchaVerification', () => {
    it('clicks hCaptcha checkbox inside the widget iframe', async () => {
      interface MockCaptchaLocator {
        click(options?: { timeout?: number; force?: boolean }): Promise<void>;
      }

      interface MockCaptchaFrameLocator {
        first(): MockCaptchaFrameLocator;
        locator(selector: string): MockCaptchaLocator;
      }

      const click = vi.fn<MockCaptchaLocator['click']>().mockResolvedValue(undefined);
      const locator = vi.fn<MockCaptchaFrameLocator['locator']>(() => ({ click }));
      const frame: MockCaptchaFrameLocator = {
        first: vi.fn<() => MockCaptchaFrameLocator>(() => frame),
        locator,
      };
      const frameLocator = vi.fn(() => frame);
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(false),
        frameLocator,
      } as unknown as CaptchaPage;

      const result = await triggerCaptchaVerification(mockPage, 'hcaptcha');

      expect(result).toBe(true);
      expect(frameLocator).toHaveBeenCalledWith('iframe[src*="hcaptcha.com"][title*="checkbox" i]');
      expect(locator).toHaveBeenCalledWith('#checkbox');
      expect(click).toHaveBeenCalledWith({ timeout: 3_000 });
    });

    it('falls back to main-page verification button evaluation without frameLocator support', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      };

      const result = await triggerCaptchaVerification(mockPage, 'hcaptcha');

      expect(result).toBe(true);
      expect(mockPage.evaluate).toHaveBeenLastCalledWith(expect.any(Function), 'hcaptcha');
    });
  });

  describe('waitForAndSolveCaptcha', () => {
    it('returns null when no captcha detected within timeout', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi.fn().mockResolvedValue(null),
      };

      const result = await waitForAndSolveCaptcha(mockPage, {
        pageUrl: 'http://test.com',
        maxWaitMs: 100,
        checkIntervalMs: 30,
      });

      expect(result).toBeNull();
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('throws when captcha detected but site key not found', async () => {
      const mockPage: CaptchaPage = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce('hcaptcha') // detectCaptcha
          .mockResolvedValueOnce(null), // extractSiteKey - not found
      };

      await expect(
        waitForAndSolveCaptcha(mockPage, {
          pageUrl: 'http://test.com',
          maxWaitMs: 1000,
          checkIntervalMs: 30,
        })
      ).rejects.toThrow('Could not extract captcha site key from page');
    });

    it('solves and injects when captcha detected', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      const mockPage: CaptchaPage = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce('hcaptcha') // detectCaptcha
          .mockResolvedValueOnce('test-site-key') // extractSiteKey
          .mockResolvedValueOnce(undefined), // injectCaptchaToken
      };

      // 2Captcha: create task → get result (plaintext format)
      mockFetch
        .mockResolvedValueOnce({
          text: () => Promise.resolve('OK|task-123'),
        })
        .mockResolvedValueOnce({
          text: () => Promise.resolve('OK|solution-token'),
        });

      const result = await waitForAndSolveCaptcha(mockPage, {
        pageUrl: 'http://test.com',
        maxWaitMs: 3000,
        checkIntervalMs: 50,
      });

      expect(result).not.toBeNull();
      expect(result?.token).toBe('solution-token');
      expect(result?.provider).toBe('twocaptcha');
    });
  });

  describe('Provider edge cases', () => {
    it('2Captcha CAPCHA_NOT_READY plaintext format', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      // 2Captcha: create task → CAPCHA_NOT_READY (plaintext format)
      mockFetch
        .mockResolvedValueOnce({
          text: () => Promise.resolve('OK|task-123'),
        })
        .mockResolvedValueOnce({
          text: () => Promise.resolve('CAPCHA_NOT_READY'),
        });

      await expect(
        solveCaptcha(
          {
            type: 'hcaptcha',
            siteKey: 'test',
            pageUrl: 'http://test.com',
          },
          { pollIntervalMs: 50, maxWaitMs: 200 }
        )
      ).rejects.toThrow();
    });
  });
});
