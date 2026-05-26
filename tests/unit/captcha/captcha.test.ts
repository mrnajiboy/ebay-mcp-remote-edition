import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  solveCaptcha,
  detectCaptcha,
  extractSiteKey,
  injectCaptchaToken,
  waitForAndSolveCaptcha,
} from '@/captcha/captcha.js';
import type { CaptchaPage } from '@/captcha/captcha.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Captcha Module', () => {
  const originalTwoCaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  const originalCapsolverKey = process.env.CAPSOLVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // Clear captcha env vars
    delete process.env.TWOCAPTCHA_API_KEY;
    delete process.env.CAPSOLVER_API_KEY;
  });

  afterEach(() => {
    // Restore env vars
    if (originalTwoCaptchaKey) {
      process.env.TWOCAPTCHA_API_KEY = originalTwoCaptchaKey;
    } else {
      delete process.env.TWOCAPTCHA_API_KEY;
    }

    if (originalCapsolverKey) {
      process.env.CAPSOLVER_API_KEY = originalCapsolverKey;
    } else {
      delete process.env.CAPSOLVER_API_KEY;
    }
  });

  describe('solveCaptcha', () => {
    it('throws when no providers configured', async () => {
      await expect(
        solveCaptcha({
          type: 'hcaptcha',
          siteKey: 'test',
          pageUrl: 'http://test.com',
        })
      ).rejects.toThrow('No captcha solver configured');
    });

    it('solves via 2Captcha when configured', async () => {
      process.env.TWOCAPTCHA_API_KEY = 'test-key';

      // Mock 2Captcha: create task → get result
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'task-123' }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'solution-token' }),
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

    it('solves via Capsolver when configured', async () => {
      process.env.CAPSOLVER_API_KEY = 'test-key';

      // Mock Capsolver: create task → get result
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ errorId: 0, taskId: 'task-456' }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              errorId: 0,
              status: 'ready',
              solution: { gRecaptchaResponse: 'capsolver-token' },
            }),
        });

      const result = await solveCaptcha(
        {
          type: 'hcaptcha',
          siteKey: 'test-site-key',
          pageUrl: 'http://test.com',
        },
        { pollIntervalMs: 100, maxWaitMs: 5000 }
      );

      expect(result.token).toBe('capsolver-token');
      expect(result.provider).toBe('capsolver');
    });

    it('falls back to next provider on timeout', async () => {
      process.env.TWOCAPTCHA_API_KEY = '***';

      // 2Captcha: create task succeeds, but keep returning CAPCHA_NOT_READY → timeout
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ status: 1, request: 'task-123' }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ status: 0, request: null }), // Still processing
        })
        .mockResolvedValueOnce({
          json: async () => ({ status: 0, request: null }), // Still processing
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
      ).rejects.toThrow(/All captcha providers failed/);
    });

    it('throws aggregated error when all providers fail', async () => {
      process.env.TWOCAPTCHA_API_KEY = 'test-key';

      // 2Captcha: API error
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ status: 0, error_text: 'ERROR_CAPTCHA_UNSOLVABLE' }),
      });

      await expect(
        solveCaptcha({
          type: 'hcaptcha',
          siteKey: 'test',
          pageUrl: 'http://test.com',
        })
      ).rejects.toThrow(/All captcha providers failed/);
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
      process.env.TWOCAPTCHA_API_KEY = 'test-key';

      const mockPage: CaptchaPage = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce('hcaptcha') // detectCaptcha
          .mockResolvedValueOnce('test-site-key') // extractSiteKey
          .mockResolvedValueOnce(undefined), // injectCaptchaToken
      };

      // 2Captcha: create task → get result
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'task-123' }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'solution-token' }),
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

  describe('Provider client edge cases', () => {
    it('Capsolver returns null when still processing', async () => {
      process.env.CAPSOLVER_API_KEY = 'test-key';

      // Capsolver: create task → still processing
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ errorId: 0, taskId: 'task-456' }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              errorId: 0,
              status: 'processing',
              solution: null,
            }),
        });

      // Should timeout and try next provider (none configured)
      await expect(
        solveCaptcha(
          {
            type: 'hcaptcha',
            siteKey: 'test',
            pageUrl: 'http://test.com',
          },
          { pollIntervalMs: 50, maxWaitMs: 200 }
        )
      ).rejects.toThrow(/All captcha providers failed/);
    });

    it('2Captcha returns CAPCHA_NOT_READY when processing', async () => {
      process.env.TWOCAPTCHA_API_KEY = 'test-key';

      // 2Captcha: create task → CAPCHA_NOT_READY (status 0, no error)
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'task-123' }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 0, request: null, error_id: 1 }), // CAPCHA_NOT_READY
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

    it('Capsolver throws on task failure', async () => {
      process.env.CAPSOLVER_API_KEY = 'test-key';

      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ errorId: 0, taskId: 'task-456' }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              errorId: 0,
              status: 'failed',
              errorDescription: 'ERROR_CAPTCHA_UNSOLVABLE',
            }),
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
      ).rejects.toThrow(/ERROR_CAPTCHA_UNSOLVABLE/);
    });
  });
});
