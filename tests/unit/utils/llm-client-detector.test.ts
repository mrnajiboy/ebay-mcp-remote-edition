/**
 * Unit tests for LLM Client Detection and Auto-Configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';

// Mock fs and os modules
vi.mock('fs');
vi.mock('os');

// Import after mocking
import {
  detectLLMClients,
  configureLLMClient,
  getAllSupportedClients,
  supportsNativeMCP,
  getManualConfigInstructions,
  verifyClientConfiguration,
} from '@/utils/llm-client-detector.js';

describe('LLM Client Detector', () => {
  const mockHomedir = '/home/testuser';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
    vi.mocked(os.platform).mockReturnValue('darwin');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('detectLLMClients', () => {
    it('should detect all 9 supported clients', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const clients = detectLLMClients();

      expect(clients).toHaveLength(9);
      expect(clients.map((c) => c.name)).toEqual([
        'claude',
        'cline',
        'continue',
        'zed',
        'cursor',
        'windsurf',
        'roocode',
        'claudecode',
        'amazonq',
      ]);
    });

    it('should detect Claude Desktop client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('Claude');
      });

      const clients = detectLLMClients();
      const claude = clients.find((c) => c.name === 'claude');

      expect(claude).toBeDefined();
      expect(claude?.detected).toBe(true);
      expect(claude?.displayName).toBe('Claude Desktop');
    });

    it('should detect Zed editor client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('zed');
      });

      const clients = detectLLMClients();
      const zed = clients.find((c) => c.name === 'zed');

      expect(zed).toBeDefined();
      expect(zed?.detected).toBe(true);
      expect(zed?.displayName).toBe('Zed Editor');
    });

    it('should detect Cursor IDE client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('.cursor');
      });

      const clients = detectLLMClients();
      const cursor = clients.find((c) => c.name === 'cursor');

      expect(cursor).toBeDefined();
      expect(cursor?.detected).toBe(true);
      expect(cursor?.displayName).toBe('Cursor IDE');
    });

    it('should detect Windsurf client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('.codeium');
      });

      const clients = detectLLMClients();
      const windsurf = clients.find((c) => c.name === 'windsurf');

      expect(windsurf).toBeDefined();
      expect(windsurf?.detected).toBe(true);
      expect(windsurf?.displayName).toBe('Windsurf (Codeium)');
    });

    it('should detect Roo Code client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('rooveterinaryinc.roo-cline');
      });

      const clients = detectLLMClients();
      const roocode = clients.find((c) => c.name === 'roocode');

      expect(roocode).toBeDefined();
      expect(roocode?.detected).toBe(true);
      expect(roocode?.displayName).toBe('Roo Code (VSCode Extension)');
    });

    it('should detect Claude Code CLI client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('.claude.json');
      });

      const clients = detectLLMClients();
      const claudecode = clients.find((c) => c.name === 'claudecode');

      expect(claudecode).toBeDefined();
      expect(claudecode?.configExists).toBe(true);
      expect(claudecode?.displayName).toBe('Claude Code CLI');
    });

    it('should detect Amazon Q client', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path.toString().includes('amazonq');
      });

      const clients = detectLLMClients();
      const amazonq = clients.find((c) => c.name === 'amazonq');

      expect(amazonq).toBeDefined();
      expect(amazonq?.detected).toBe(true);
      expect(amazonq?.displayName).toBe('Amazon Q Developer');
    });

    it('should set configExists to true when config file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const clients = detectLLMClients();

      clients.forEach((client) => {
        expect(client.configExists).toBe(true);
        expect(client.detected).toBe(true);
      });
    });
  });

  describe('getAllSupportedClients', () => {
    it('should return all 9 supported client names', () => {
      const clients = getAllSupportedClients();

      expect(clients).toHaveLength(9);
      expect(clients).toContain('claude');
      expect(clients).toContain('cline');
      expect(clients).toContain('continue');
      expect(clients).toContain('zed');
      expect(clients).toContain('cursor');
      expect(clients).toContain('windsurf');
      expect(clients).toContain('roocode');
      expect(clients).toContain('claudecode');
      expect(clients).toContain('amazonq');
    });
  });

  describe('supportsNativeMCP', () => {
    it('should return true for all supported clients', () => {
      const supportedClients = [
        'claude',
        'cline',
        'continue',
        'zed',
        'cursor',
        'windsurf',
        'roocode',
        'claudecode',
        'amazonq',
      ];

      supportedClients.forEach((client) => {
        expect(supportsNativeMCP(client)).toBe(true);
      });
    });

    it('should be case-insensitive', () => {
      expect(supportsNativeMCP('CLAUDE')).toBe(true);
      expect(supportsNativeMCP('Zed')).toBe(true);
      expect(supportsNativeMCP('CURSOR')).toBe(true);
    });

    it('should return false for unsupported clients', () => {
      expect(supportsNativeMCP('unknown')).toBe(false);
      expect(supportsNativeMCP('chatgpt')).toBe(false);
      expect(supportsNativeMCP('gemini')).toBe(false);
    });
  });

  describe('configureLLMClient', () => {
    const projectRoot = '/test/project';

    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    });

    it('should configure Claude Desktop', () => {
      const result = configureLLMClient('claude', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should configure Zed editor', () => {
      const result = configureLLMClient('zed', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should configure Cursor IDE', () => {
      const result = configureLLMClient('cursor', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should configure Windsurf', () => {
      const result = configureLLMClient('windsurf', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should configure Roo Code', () => {
      const result = configureLLMClient('roocode', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should configure Claude Code CLI', () => {
      const result = configureLLMClient('claudecode', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should configure Amazon Q', () => {
      const result = configureLLMClient('amazonq', projectRoot);

      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should return false for unknown client', () => {
      const result = configureLLMClient('unknown', projectRoot);

      expect(result).toBe(false);
    });
  });

  describe('getManualConfigInstructions', () => {
    const projectRoot = '/test/project';

    it('should return instructions for Claude Desktop', () => {
      const instructions = getManualConfigInstructions('claude', projectRoot);

      expect(instructions).toContain('mcpServers');
      expect(instructions).toContain('ebay-mcp-server');
      expect(instructions).toContain('node');
    });

    it('should return instructions for Zed editor', () => {
      const instructions = getManualConfigInstructions('zed', projectRoot);

      expect(instructions).toContain('context_servers');
      expect(instructions).toContain('ebay-mcp-server');
      expect(instructions).toContain('path');
    });

    it('should return instructions for Cursor IDE', () => {
      const instructions = getManualConfigInstructions('cursor', projectRoot);

      expect(instructions).toContain('mcpServers');
      expect(instructions).toContain('ebay-mcp-server');
    });

    it('should return instructions for Windsurf', () => {
      const instructions = getManualConfigInstructions('windsurf', projectRoot);

      expect(instructions).toContain('mcpServers');
      expect(instructions).toContain('ebay-mcp-server');
    });

    it('should return instructions for Roo Code', () => {
      const instructions = getManualConfigInstructions('roocode', projectRoot);

      expect(instructions).toContain('mcpServers');
      expect(instructions).toContain('ebay-mcp-server');
    });

    it('should return instructions for Claude Code CLI', () => {
      const instructions = getManualConfigInstructions('claudecode', projectRoot);

      expect(instructions).toContain('mcpServers');
      expect(instructions).toContain('ebay-mcp-server');
    });

    it('should return instructions for Amazon Q', () => {
      const instructions = getManualConfigInstructions('amazonq', projectRoot);

      expect(instructions).toContain('mcpServers');
      expect(instructions).toContain('ebay-mcp-server');
    });

    it('should return default message for unknown client', () => {
      const instructions = getManualConfigInstructions('unknown', projectRoot);

      expect(instructions).toContain('not available');
    });
  });

  describe('verifyClientConfiguration', () => {
    const projectRoot = '/test/project';

    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
    });

    it('should verify Claude Desktop configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'ebay-mcp-server': { command: 'node', args: [] },
          },
        })
      );

      const result = verifyClientConfiguration('claude', projectRoot);

      expect(result).toBe(true);
    });

    it('should verify Zed configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          context_servers: {
            'ebay-mcp-server': { command: { path: 'node' } },
          },
        })
      );

      const result = verifyClientConfiguration('zed', projectRoot);

      expect(result).toBe(true);
    });

    it('should verify Cursor configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'ebay-mcp-server': { command: 'node', args: [] },
          },
        })
      );

      const result = verifyClientConfiguration('cursor', projectRoot);

      expect(result).toBe(true);
    });

    it('should verify Windsurf configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'ebay-mcp-server': { command: 'node', args: [] },
          },
        })
      );

      const result = verifyClientConfiguration('windsurf', projectRoot);

      expect(result).toBe(true);
    });

    it('should verify Roo Code configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'ebay-mcp-server': { command: 'node', args: [] },
          },
        })
      );

      const result = verifyClientConfiguration('roocode', projectRoot);

      expect(result).toBe(true);
    });

    it('should verify Claude Code CLI configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'ebay-mcp-server': { command: 'node', args: [] },
          },
        })
      );

      const result = verifyClientConfiguration('claudecode', projectRoot);

      expect(result).toBe(true);
    });

    it('should verify Amazon Q configuration', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'ebay-mcp-server': { command: 'node', args: [] },
          },
        })
      );

      const result = verifyClientConfiguration('amazonq', projectRoot);

      expect(result).toBe(true);
    });

    it('should return false when config file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = verifyClientConfiguration('claude', projectRoot);

      expect(result).toBe(false);
    });

    it('should return false when ebay-mcp-server is not configured', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          mcpServers: {},
        })
      );

      const result = verifyClientConfiguration('claude', projectRoot);

      expect(result).toBe(false);
    });

    it('should return false for unknown client', () => {
      const result = verifyClientConfiguration('unknown', projectRoot);

      expect(result).toBe(false);
    });
  });

  describe('Platform-specific paths', () => {
    const testCases = [
      { platform: 'darwin', pathPart: 'Library' },
      { platform: 'win32', pathPart: 'AppData' },
      { platform: 'linux', pathPart: '.config' },
    ] as const;

    testCases.forEach(({ platform, pathPart }) => {
      it(`should use correct paths on ${platform}`, () => {
        vi.mocked(os.platform).mockReturnValue(platform);
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const clients = detectLLMClients();

        // Claude Desktop should have platform-specific path
        const claude = clients.find((c) => c.name === 'claude');
        expect(claude?.configPath).toContain(pathPart);
      });
    });
  });
});
