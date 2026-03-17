/**
 * LLM Client Detection and Auto-Configuration
 *
 * Detects installed LLM clients and provides utilities to auto-configure them
 * with the eBay MCP server settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';

export interface LLMClient {
  name: string;
  displayName: string;
  configPath: string;
  detected: boolean;
  configExists: boolean;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Get the config file path for Claude Desktop based on OS
 */
function getClaudeConfigPath(): string {
  const os = platform();
  const home = homedir();

  switch (os) {
    case 'darwin': // macOS
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32': // Windows
      return join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

/**
 * Get the config file path for Cline (VSCode extension)
 */
function getClineConfigPath(): string {
  const home = homedir();
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      );
    case 'win32':
      return join(
        home,
        'AppData',
        'Roaming',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      );
    default:
      return join(
        home,
        '.config',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      );
  }
}

/**
 * Get config path for Continue.dev
 */
function getContinueConfigPath(): string {
  const home = homedir();
  return join(home, '.continue', 'config.json');
}

/**
 * Get config path for Zed editor
 */
function getZedConfigPath(): string {
  const home = homedir();
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(home, '.config', 'zed', 'settings.json');
    case 'win32':
      return join(home, 'AppData', 'Roaming', 'Zed', 'settings.json');
    default:
      return join(home, '.config', 'zed', 'settings.json');
  }
}

/**
 * Get config path for Cursor IDE
 */
function getCursorConfigPath(): string {
  const home = homedir();
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(home, '.cursor', 'mcp.json');
    case 'win32':
      return join(home, '.cursor', 'mcp.json');
    default:
      return join(home, '.cursor', 'mcp.json');
  }
}

/**
 * Get config path for Windsurf (Codeium)
 */
function getWindsurfConfigPath(): string {
  const home = homedir();
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'win32':
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');
    default:
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');
  }
}

/**
 * Get config path for Roo Code (VSCode extension)
 */
function getRooCodeConfigPath(): string {
  const home = homedir();
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json'
      );
    case 'win32':
      return join(
        home,
        'AppData',
        'Roaming',
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json'
      );
    default:
      return join(
        home,
        '.config',
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json'
      );
  }
}

/**
 * Get config path for Claude Code CLI
 */
function getClaudeCodeConfigPath(): string {
  const home = homedir();
  return join(home, '.claude.json');
}

/**
 * Get config path for Amazon Q Developer
 */
function getAmazonQConfigPath(): string {
  const home = homedir();
  const os = platform();

  switch (os) {
    case 'darwin':
      return join(home, '.aws', 'amazonq', 'mcp.json');
    case 'win32':
      return join(home, '.aws', 'amazonq', 'mcp.json');
    default:
      return join(home, '.aws', 'amazonq', 'mcp.json');
  }
}

/**
 * Detect all available LLM clients
 */
export function detectLLMClients(): LLMClient[] {
  const clients: LLMClient[] = [
    {
      name: 'claude',
      displayName: 'Claude Desktop',
      configPath: getClaudeConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'cline',
      displayName: 'Cline (VSCode Extension)',
      configPath: getClineConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'continue',
      displayName: 'Continue.dev',
      configPath: getContinueConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'zed',
      displayName: 'Zed Editor',
      configPath: getZedConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'cursor',
      displayName: 'Cursor IDE',
      configPath: getCursorConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'windsurf',
      displayName: 'Windsurf (Codeium)',
      configPath: getWindsurfConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'roocode',
      displayName: 'Roo Code (VSCode Extension)',
      configPath: getRooCodeConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'claudecode',
      displayName: 'Claude Code CLI',
      configPath: getClaudeCodeConfigPath(),
      detected: false,
      configExists: false,
    },
    {
      name: 'amazonq',
      displayName: 'Amazon Q Developer',
      configPath: getAmazonQConfigPath(),
      detected: false,
      configExists: false,
    },
  ];

  // Check which clients exist
  for (const client of clients) {
    client.configExists = existsSync(client.configPath);
    // Check if parent directory exists (indicates app is installed)
    const parentDir = dirname(client.configPath);
    client.detected = existsSync(parentDir);
  }

  return clients;
}

/**
 * Read and parse JSON config file safely
 */
function readJSONConfig(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) {
      return {};
    }
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write JSON config file safely
 */
function writeJSONConfig(path: string, config: Record<string, unknown>): void {
  // Ensure directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Configure Claude Desktop with eBay MCP server
 */
export function configureClaudeDesktop(projectRoot: string): boolean {
  try {
    const configPath = getClaudeConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Claude Desktop:', error);
    return false;
  }
}

/**
 * Configure Cline (VSCode extension) with eBay MCP server
 */
export function configureCline(projectRoot: string): boolean {
  try {
    const configPath = getClineConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Cline:', error);
    return false;
  }
}

/**
 * Configure Continue.dev with eBay MCP server
 */
export function configureContinue(projectRoot: string): boolean {
  try {
    const configPath = getContinueConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize experimental.modelContextProtocolServers if it doesn't exist
    if (!config.experimental || typeof config.experimental !== 'object') {
      config.experimental = {};
    }

    const experimental = config.experimental as Record<string, unknown>;

    if (
      !experimental.modelContextProtocolServers ||
      !Array.isArray(experimental.modelContextProtocolServers)
    ) {
      experimental.modelContextProtocolServers = [];
    }

    const mcpServers = experimental.modelContextProtocolServers as MCPServerConfig[];

    // Check if eBay server already exists
    const existingIndex = mcpServers.findIndex(
      (server) => server.command === 'node' && server.args?.[0]?.includes('ebay-mcp')
    );

    const serverConfig: MCPServerConfig = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    if (existingIndex >= 0) {
      mcpServers[existingIndex] = serverConfig;
    } else {
      mcpServers.push(serverConfig);
    }

    experimental.modelContextProtocolServers = mcpServers;
    config.experimental = experimental;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Continue.dev:', error);
    return false;
  }
}

/**
 * Configure Zed editor with eBay MCP server
 * Zed uses context_servers in settings.json
 */
export function configureZed(projectRoot: string): boolean {
  try {
    const configPath = getZedConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize context_servers if it doesn't exist
    if (!config.context_servers || typeof config.context_servers !== 'object') {
      config.context_servers = {};
    }

    const contextServers = config.context_servers as Record<string, unknown>;

    // Add or update eBay MCP server configuration
    contextServers['ebay-mcp-server'] = {
      command: {
        path: 'node',
        args: [join(projectRoot, 'build', 'index.js')],
      },
      settings: {},
    };

    config.context_servers = contextServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Zed:', error);
    return false;
  }
}

/**
 * Configure Cursor IDE with eBay MCP server
 * Cursor uses mcpServers in mcp.json
 */
export function configureCursor(projectRoot: string): boolean {
  try {
    const configPath = getCursorConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Cursor:', error);
    return false;
  }
}

/**
 * Configure Windsurf (Codeium) with eBay MCP server
 */
export function configureWindsurf(projectRoot: string): boolean {
  try {
    const configPath = getWindsurfConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Windsurf:', error);
    return false;
  }
}

/**
 * Configure Roo Code (VSCode extension) with eBay MCP server
 */
export function configureRooCode(projectRoot: string): boolean {
  try {
    const configPath = getRooCodeConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Roo Code:', error);
    return false;
  }
}

/**
 * Configure Claude Code CLI with eBay MCP server
 * Claude Code CLI uses mcpServers in ~/.claude.json
 */
export function configureClaudeCode(projectRoot: string): boolean {
  try {
    const configPath = getClaudeCodeConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Claude Code CLI:', error);
    return false;
  }
}

/**
 * Configure Amazon Q Developer with eBay MCP server
 */
export function configureAmazonQ(projectRoot: string): boolean {
  try {
    const configPath = getAmazonQConfigPath();
    const config = readJSONConfig(configPath);

    // Initialize mcpServers if it doesn't exist
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, MCPServerConfig>;

    // Add or update eBay MCP server configuration
    mcpServers['ebay-mcp-server'] = {
      command: 'node',
      args: [join(projectRoot, 'build', 'index.js')],
    };

    config.mcpServers = mcpServers;
    writeJSONConfig(configPath, config);

    return true;
  } catch (error) {
    console.error('Failed to configure Amazon Q:', error);
    return false;
  }
}

/**
 * Configure specified LLM client
 */
export function configureLLMClient(clientName: string, projectRoot: string): boolean {
  switch (clientName) {
    case 'claude':
      return configureClaudeDesktop(projectRoot);
    case 'cline':
      return configureCline(projectRoot);
    case 'continue':
      return configureContinue(projectRoot);
    case 'zed':
      return configureZed(projectRoot);
    case 'cursor':
      return configureCursor(projectRoot);
    case 'windsurf':
      return configureWindsurf(projectRoot);
    case 'roocode':
      return configureRooCode(projectRoot);
    case 'claudecode':
      return configureClaudeCode(projectRoot);
    case 'amazonq':
      return configureAmazonQ(projectRoot);
    default:
      return false;
  }
}

/**
 * Get human-readable instructions for manual configuration
 */
export function getManualConfigInstructions(clientName: string, projectRoot: string): string {
  const buildPath = join(projectRoot, 'build', 'index.js');

  switch (clientName) {
    case 'claude':
      return `
Add this to ${getClaudeConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    case 'cline':
      return `
Add this to ${getClineConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    case 'continue':
      return `
Add this to ${getContinueConfigPath()}:

{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "command": "node",
        "args": ["${buildPath}"]
      }
    ]
  }
}`;

    case 'zed':
      return `
Add this to ${getZedConfigPath()}:

{
  "context_servers": {
    "ebay-mcp-server": {
      "command": {
        "path": "node",
        "args": ["${buildPath}"]
      },
      "settings": {}
    }
  }
}`;

    case 'cursor':
      return `
Add this to ${getCursorConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    case 'windsurf':
      return `
Add this to ${getWindsurfConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    case 'roocode':
      return `
Add this to ${getRooCodeConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    case 'claudecode':
      return `
Add this to ${getClaudeCodeConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    case 'amazonq':
      return `
Add this to ${getAmazonQConfigPath()}:

{
  "mcpServers": {
    "ebay-mcp-server": {
      "command": "node",
      "args": ["${buildPath}"]
    }
  }
}`;

    default:
      return 'Manual configuration instructions not available for this client.';
  }
}

/**
 * Verify client configuration is correct
 */
export function verifyClientConfiguration(clientName: string, projectRoot: string): boolean {
  try {
    switch (clientName) {
      case 'claude': {
        const configPath = getClaudeConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      case 'cline': {
        const configPath = getClineConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      case 'continue': {
        const configPath = getContinueConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const experimental = config.experimental as Record<string, unknown> | undefined;
        const mcpServers = experimental?.modelContextProtocolServers as
          | MCPServerConfig[]
          | undefined;

        return !!mcpServers?.some((server) => server.args?.[0]?.includes('ebay-mcp-server'));
      }

      case 'zed': {
        const configPath = getZedConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const contextServers = config.context_servers as Record<string, unknown> | undefined;

        return !!contextServers?.['ebay-mcp-server'];
      }

      case 'cursor': {
        const configPath = getCursorConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      case 'windsurf': {
        const configPath = getWindsurfConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      case 'roocode': {
        const configPath = getRooCodeConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      case 'claudecode': {
        const configPath = getClaudeCodeConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      case 'amazonq': {
        const configPath = getAmazonQConfigPath();
        if (!existsSync(configPath)) return false;

        const config = readJSONConfig(configPath);
        const mcpServers = config.mcpServers as Record<string, MCPServerConfig> | undefined;

        return !!mcpServers?.['ebay-mcp-server'];
      }

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Get all LLM clients (detected and undetected)
 */
export function getAllSupportedClients(): string[] {
  return [
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
}

/**
 * Check if client supports MCP protocol
 */
export function supportsNativeMCP(clientName: string): boolean {
  // All these clients support MCP (Model Context Protocol)
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
  return supportedClients.includes(clientName.toLowerCase());
}
