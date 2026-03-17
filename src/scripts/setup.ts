#!/usr/bin/env node

import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';

import axios from 'axios';
import chalk from 'chalk';
import { checkForUpdates } from '../utils/version.js';
import { config } from 'dotenv';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { getOAuthAuthorizationUrl } from '../config/environment.js';
import prompts from 'prompts';

config({ quiet: true });

checkForUpdates();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

const TOTAL_STEPS = 6;

type StepResult = 'continue' | 'back' | 'cancel';

interface SetupState {
  currentStep: number;
  config: Record<string, string>;
  detectedClients: LLMClient[];
  environment: 'sandbox' | 'production';
  hasExistingConfig: boolean;
  isQuickMode: boolean;
}

interface LLMClient {
  name: string;
  displayName: string;
  configPath: string;
  detected: boolean;
  configExists: boolean;
}

const ebay = {
  red: chalk.hex('#E53238'),
  blue: chalk.hex('#0064D2'),
  yellow: chalk.hex('#F5AF02'),
  green: chalk.hex('#86B817'),
};

const ui = {
  dim: chalk.dim,
  bold: chalk.bold,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.cyan,
  hint: chalk.gray,
};

const MARKETPLACE_OPTIONS: { value: string; label: string }[] = [
  { value: 'EBAY_US', label: 'EBAY_US — United States' },
  { value: 'EBAY_GB', label: 'EBAY_GB — United Kingdom' },
  { value: 'EBAY_DE', label: 'EBAY_DE — Germany' },
  { value: 'EBAY_FR', label: 'EBAY_FR — France' },
  { value: 'EBAY_IT', label: 'EBAY_IT — Italy' },
  { value: 'EBAY_ES', label: 'EBAY_ES — Spain' },
  { value: 'EBAY_CA', label: 'EBAY_CA — Canada' },
  { value: 'EBAY_AU', label: 'EBAY_AU — Australia' },
];

const CONTENT_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en-US', label: 'en-US — English (United States)' },
  { value: 'en-GB', label: 'en-GB — English (United Kingdom)' },
  { value: 'de-DE', label: 'de-DE — German (Germany)' },
  { value: 'fr-FR', label: 'fr-FR — French (France)' },
  { value: 'it-IT', label: 'it-IT — Italian (Italy)' },
  { value: 'es-ES', label: 'es-ES — Spanish (Spain)' },
  { value: 'fr-CA', label: 'fr-CA — French (Canada)' },
  { value: 'nl-BE', label: 'nl-BE — Dutch (Belgium)' },
];

const LOGO = `
   ${ebay.red('███████╗')}${ebay.blue('██████╗ ')}${ebay.yellow('█████╗ ')}${ebay.green('██╗   ██╗')}
   ${ebay.red('██╔════╝')}${ebay.blue('██╔══██╗')}${ebay.yellow('██╔══██╗')}${ebay.green('╚██╗ ██╔╝')}
   ${ebay.red('█████╗  ')}${ebay.blue('██████╔╝')}${ebay.yellow('███████║')}${ebay.green(' ╚████╔╝ ')}
   ${ebay.red('██╔══╝  ')}${ebay.blue('██╔══██╗')}${ebay.yellow('██╔══██║')}${ebay.green('  ╚██╔╝  ')}
   ${ebay.red('███████╗')}${ebay.blue('██████╔╝')}${ebay.yellow('██║  ██║')}${ebay.green('   ██║   ')}
   ${ebay.red('╚══════╝')}${ebay.blue('╚═════╝ ')}${ebay.yellow('╚═╝  ╚═╝')}${ebay.green('   ╚═╝   ')}
`;

/**
 * Clear the terminal screen.
 */
function clearScreen(): void {
  console.clear();
}

/**
 * Render the eBay ASCII logo and heading.
 */
function showLogo(): void {
  console.log(LOGO);
  console.log(ui.bold.white('            MCP Server Setup Wizard by Yosef Hayim Sabag\n'));
}

/**
 * Render a step progress bar with title.
 */
function showProgress(step: number, title: string): void {
  const filled = '●'.repeat(step);
  const empty = '○'.repeat(TOTAL_STEPS - step);
  const progress = `${ui.info(filled)}${ui.dim(empty)}`;

  console.log(ui.dim('─'.repeat(60)));
  console.log(`  ${progress}  ${ui.bold(`Step ${step}/${TOTAL_STEPS}`)}: ${title}`);
  console.log(ui.dim('─'.repeat(60)) + '\n');
}

/**
 * Render keyboard hints for the current step.
 */
function showKeyboardHints(hints: string[]): void {
  const hintText = hints.map((h) => ui.dim(h)).join('  │  ');
  console.log(`\n  ${hintText}\n`);
}

/**
 * Render a tip callout.
 */
function showTip(message: string): void {
  console.log(`  ${ebay.yellow('💡 Tip:')} ${ui.dim(message)}\n`);
}

/**
 * Render a success line.
 */
function showSuccess(message: string): void {
  console.log(`  ${ui.success('✓')} ${message}`);
}

/**
 * Render an error line.
 */
function showError(message: string): void {
  console.log(`  ${ui.error('✗')} ${message}`);
}

/**
 * Open a URL in the default browser (cross-platform).
 */
function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();
    let command: string;

    switch (os) {
      case 'darwin':
        command = `open "${url}"`;
        break;
      case 'win32':
        command = `start "" "${url}"`;
        break;
      default:
        command = `xdg-open "${url}"`;
    }

    exec(command, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Render a warning line.
 */
function showWarning(message: string): void {
  console.log(`  ${ui.warning('⚠')} ${message}`);
}

/**
 * Parse authorization code from callback URL or raw code
 * Handles both full URLs and just the code parameter
 */
function parseAuthorizationCode(input: string): string | null {
  const trimmed = input.trim();

  // If it looks like a URL, parse the code parameter
  if (trimmed.includes('code=') || trimmed.includes('?') || trimmed.includes('&')) {
    try {
      // Handle both full URLs and query strings
      let searchParams: URLSearchParams;

      if (trimmed.startsWith('http')) {
        const url = new URL(trimmed);
        searchParams = url.searchParams;
      } else {
        // It might just be query params like "code=xxx&expires_in=299"
        searchParams = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
      }

      const code = searchParams.get('code');
      if (code) {
        // URL decode the code (it's often URL-encoded)
        return decodeURIComponent(code);
      }
    } catch {
      // Fall through to try as raw code
    }
  }

  // Check if it looks like a raw authorization code (starts with v^1.1#)
  if (trimmed.startsWith('v^1.1#') || trimmed.startsWith('v%5E1.1')) {
    // Decode if URL-encoded
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }

  return null;
}

interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

interface EbayUserInfo {
  userId: string;
  username: string;
  accountType?: string;
  registrationMarketplaceId?: string;
  individualAccount?: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  businessAccount?: {
    name?: string;
    email?: string;
  };
}

/**
 * Exchange authorization code for tokens using eBay API
 * This mirrors the logic in auth/oauth.ts EbayOAuthClient.exchangeCodeForToken()
 */
async function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  environment: 'sandbox' | 'production'
): Promise<TokenExchangeResult> {
  const tokenUrl =
    environment === 'production'
      ? 'https://api.ebay.com/identity/v1/oauth2/token'
      : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresIn: response.data.expires_in,
    refreshTokenExpiresIn: response.data.refresh_token_expires_in,
  };
}

/**
 * Get app access token using client credentials flow
 * This mirrors the logic in auth/oauth.ts EbayOAuthClient.getOrRefreshAppAccessToken()
 */
async function getAppAccessToken(
  clientId: string,
  clientSecret: string,
  environment: 'sandbox' | 'production'
): Promise<string> {
  const tokenUrl =
    environment === 'production'
      ? 'https://api.ebay.com/identity/v1/oauth2/token'
      : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  return response.data.access_token;
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  environment: 'sandbox' | 'production'
): Promise<{ accessToken: string; expiresIn: number }> {
  const tokenUrl =
    environment === 'production'
      ? 'https://api.ebay.com/identity/v1/oauth2/token'
      : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  return {
    accessToken: response.data.access_token,
    expiresIn: response.data.expires_in,
  };
}

/**
 * Verify refresh token by getting an access token and fetching user info
 */
async function verifyRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  environment: 'sandbox' | 'production'
): Promise<{ accessToken: string; userInfo: EbayUserInfo }> {
  // First, refresh to get an access token
  const { accessToken } = await refreshAccessToken(
    refreshToken,
    clientId,
    clientSecret,
    environment
  );

  // Then fetch user info to verify everything works
  const userInfo = await fetchEbayUserInfo(accessToken, environment);

  return { accessToken, userInfo };
}

/**
 * Fetch eBay user info using the Identity API
 * Uses apiz.ebay.com subdomain as per eBay API requirements
 */
async function fetchEbayUserInfo(
  accessToken: string,
  environment: 'sandbox' | 'production'
): Promise<EbayUserInfo> {
  const identityBaseUrl =
    environment === 'production' ? 'https://apiz.ebay.com' : 'https://apiz.sandbox.ebay.com';

  const response = await axios.get(`${identityBaseUrl}/commerce/identity/v1/user/`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data;
}

/**
 * Display eBay user info in a formatted box
 */
function displayUserInfo(userInfo: EbayUserInfo): void {
  const accountName =
    userInfo.individualAccount?.firstName && userInfo.individualAccount?.lastName
      ? `${userInfo.individualAccount.firstName} ${userInfo.individualAccount.lastName}`
      : userInfo.businessAccount?.name || 'N/A';

  const email = userInfo.individualAccount?.email || userInfo.businessAccount?.email || 'N/A';

  const marketplaceMap: Record<string, string> = {
    EBAY_US: 'eBay United States',
    EBAY_GB: 'eBay United Kingdom',
    EBAY_DE: 'eBay Germany',
    EBAY_AU: 'eBay Australia',
    EBAY_CA: 'eBay Canada',
    EBAY_FR: 'eBay France',
    EBAY_IT: 'eBay Italy',
    EBAY_ES: 'eBay Spain',
  };

  const marketplace =
    marketplaceMap[userInfo.registrationMarketplaceId || ''] ||
    userInfo.registrationMarketplaceId ||
    'N/A';

  showBox('eBay Account Verified', [
    `Username:        ${userInfo.username}`,
    `Account Name:    ${accountName}`,
    `Email:           ${email}`,
    `Account Type:    ${userInfo.accountType || 'N/A'}`,
    `Marketplace:     ${marketplace}`,
    `User ID:         ${userInfo.userId?.slice(0, 30)}...`,
  ]);
}

/**
 * Render an informational line.
 */
function showInfo(message: string): void {
  console.log(`  ${ui.info('ℹ')} ${message}`);
}

/**
 * Render a spinner and return a stop callback.
 */
function showSpinner(message: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;

  process.stdout.write(`  ${ui.info(frames[0])} ${message}`);

  const interval = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r  ${ui.info(frames[i])} ${message}`);
  }, 80);

  return () => {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(message.length + 10) + '\r');
  };
}

/**
 * Render a bordered info box.
 */
function showBox(title: string, content: string[]): void {
  const width = 60;
  const line = '─'.repeat(width - 2);

  console.log(`\n  ${ui.dim('┌' + line + '┐')}`);
  console.log(`  ${ui.dim('│')} ${ui.bold(title.padEnd(width - 3))}${ui.dim('│')}`);
  console.log(`  ${ui.dim('├' + line + '┤')}`);

  for (const item of content) {
    const displayItem = item.length > width - 4 ? item.slice(0, width - 7) + '...' : item;
    console.log(`  ${ui.dim('│')} ${displayItem.padEnd(width - 3)}${ui.dim('│')}`);
  }

  console.log(`  ${ui.dim('└' + line + '┘')}\n`);
}

/**
 * Compute MCP client config paths by OS.
 */
function getConfigPaths(): Record<string, { display: string; path: string }> {
  const home = homedir();
  const os = platform();
  const paths: Record<string, { display: string; path: string }> = {};

  if (os === 'darwin') {
    paths.claude = {
      display: 'Claude Desktop',
      path: join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
    };
    paths.cline = {
      display: 'Cline (VSCode)',
      path: join(
        home,
        'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'
      ),
    };
  } else if (os === 'win32') {
    paths.claude = {
      display: 'Claude Desktop',
      path: join(home, 'AppData/Roaming/Claude/claude_desktop_config.json'),
    };
    paths.cline = {
      display: 'Cline (VSCode)',
      path: join(
        home,
        'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'
      ),
    };
  } else {
    paths.claude = {
      display: 'Claude Desktop',
      path: join(home, '.config/Claude/claude_desktop_config.json'),
    };
    paths.cline = {
      display: 'Cline (VSCode)',
      path: join(
        home,
        '.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'
      ),
    };
  }

  paths.continue = {
    display: 'Continue.dev',
    path: join(home, '.continue/config.json'),
  };

  return paths;
}

/**
 * Detect installed MCP-compatible clients.
 */
function detectLLMClients(): LLMClient[] {
  const paths = getConfigPaths();
  const clients: LLMClient[] = [];

  for (const [name, info] of Object.entries(paths)) {
    const configExists = existsSync(info.path);
    const parentExists = existsSync(dirname(info.path));

    clients.push({
      name,
      displayName: info.display,
      configPath: info.path,
      detected: parentExists,
      configExists,
    });
  }

  return clients;
}

/**
 * Write MCP server config for a detected client.
 */
function configureLLMClient(client: LLMClient, projectRoot: string): boolean {
  try {
    const configDir = dirname(client.configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    interface McpConfig {
      mcpServers?: Record<string, unknown>;
      experimental?: {
        modelContextProtocolServers?: unknown[];
      };
      [key: string]: unknown;
    }

    let existingConfig: McpConfig = {};

    if (existsSync(client.configPath)) {
      try {
        existingConfig = JSON.parse(readFileSync(client.configPath, 'utf-8')) as McpConfig;
      } catch {
        existingConfig = {};
      }
    }

    const serverConfig = {
      command: 'node',
      args: [join(projectRoot, 'build/index.js')],
    };

    if (client.name === 'continue') {
      if (!existingConfig.experimental) existingConfig.experimental = {};
      if (!existingConfig.experimental.modelContextProtocolServers) {
        existingConfig.experimental.modelContextProtocolServers = [];
      }
      const servers = existingConfig.experimental.modelContextProtocolServers as unknown[];
      const existingIndex = servers.findIndex((s: unknown) =>
        (s as { command?: string; args?: string[] })?.args?.[0]?.includes('ebay-mcp')
      );
      if (existingIndex >= 0) {
        servers[existingIndex] = serverConfig;
      } else {
        servers.push(serverConfig);
      }
    } else {
      if (!existingConfig.mcpServers) existingConfig.mcpServers = {};
      existingConfig.mcpServers['ebay'] = serverConfig;
    }

    writeFileSync(client.configPath, JSON.stringify(existingConfig, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Claude Desktop config path for the current platform
 */
function getClaudeDesktopConfigPath(): string {
  const home = homedir();
  const os = platform();

  if (os === 'darwin') {
    return join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  } else if (os === 'win32') {
    return join(home, 'AppData/Roaming/Claude/claude_desktop_config.json');
  } else {
    return join(home, '.config/Claude/claude_desktop_config.json');
  }
}

/**
 * Check if Claude Desktop is installed
 */
function isClaudeDesktopInstalled(): boolean {
  const configPath = getClaudeDesktopConfigPath();
  const configDir = dirname(configPath);
  return existsSync(configDir);
}

/**
 * Update Claude Desktop config with eBay MCP server credentials
 * This ensures Claude Desktop has access to the verified tokens
 * IMPORTANT: This preserves all existing mcpServers and other config
 */
function updateClaudeDesktopConfig(
  envConfig: Record<string, string>,
  environment: string
): { success: boolean; configPath: string; error?: string; details?: string } {
  const configPath = getClaudeDesktopConfigPath();
  const configDir = dirname(configPath);

  // Check if Claude Desktop is installed
  if (!existsSync(configDir)) {
    return { success: false, configPath, error: 'Claude Desktop not installed' };
  }

  try {
    // Read existing config - preserve everything
    let existingConfig: Record<string, unknown> = {};

    if (existsSync(configPath)) {
      try {
        const fileContent = readFileSync(configPath, 'utf-8');
        existingConfig = JSON.parse(fileContent) as Record<string, unknown>;
      } catch (parseError) {
        // If JSON is invalid, start fresh but warn user
        return {
          success: false,
          configPath,
          error: `Invalid JSON in config file: ${parseError instanceof Error ? parseError.message : 'Parse error'}`,
          details: 'Please fix the JSON syntax in your Claude config file',
        };
      }
    }

    // Ensure mcpServers exists as an object
    if (!existingConfig.mcpServers || typeof existingConfig.mcpServers !== 'object') {
      existingConfig.mcpServers = {};
    }

    const mcpServers = existingConfig.mcpServers as Record<string, unknown>;

    // Build env object with all credentials
    const envVars: Record<string, string> = {
      EBAY_ENVIRONMENT: environment,
    };

    if (envConfig.EBAY_CLIENT_ID) {
      envVars.EBAY_CLIENT_ID = envConfig.EBAY_CLIENT_ID;
    }
    if (envConfig.EBAY_CLIENT_SECRET) {
      envVars.EBAY_CLIENT_SECRET = envConfig.EBAY_CLIENT_SECRET;
    }
    if (envConfig.EBAY_REDIRECT_URI) {
      envVars.EBAY_REDIRECT_URI = envConfig.EBAY_REDIRECT_URI;
    }
    if (envConfig.EBAY_MARKETPLACE_ID) {
      envVars.EBAY_MARKETPLACE_ID = envConfig.EBAY_MARKETPLACE_ID;
    }
    if (envConfig.EBAY_CONTENT_LANGUAGE) {
      envVars.EBAY_CONTENT_LANGUAGE = envConfig.EBAY_CONTENT_LANGUAGE;
    }
    if (envConfig.EBAY_USER_REFRESH_TOKEN) {
      envVars.EBAY_USER_REFRESH_TOKEN = envConfig.EBAY_USER_REFRESH_TOKEN;
    }
    // Only include access tokens if they exist and are not empty
    if (envConfig.EBAY_USER_ACCESS_TOKEN && envConfig.EBAY_USER_ACCESS_TOKEN.startsWith('v^')) {
      envVars.EBAY_USER_ACCESS_TOKEN = envConfig.EBAY_USER_ACCESS_TOKEN;
    }
    if (envConfig.EBAY_APP_ACCESS_TOKEN && envConfig.EBAY_APP_ACCESS_TOKEN.startsWith('v^')) {
      envVars.EBAY_APP_ACCESS_TOKEN = envConfig.EBAY_APP_ACCESS_TOKEN;
    }

    // Add or update only the 'ebay' server - preserve all other servers
    // Use npx with --yes flag and suppress npm/node output to keep stdout clean for MCP
    mcpServers['ebay'] = {
      command: 'npx',
      args: ['--yes', '--quiet', 'ebay-mcp'],
      env: {
        ...envVars,
        NODE_NO_WARNINGS: '1',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      },
    };

    // Write back the complete config with proper formatting
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    // Count existing servers for confirmation message
    const serverCount = Object.keys(mcpServers).length;
    const otherServers = Object.keys(mcpServers).filter((k) => k !== 'ebay');

    return {
      success: true,
      configPath,
      details:
        otherServers.length > 0
          ? `Preserved ${otherServers.length} existing server(s): ${otherServers.join(', ')}`
          : `Added ebay server (${serverCount} total)`,
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Load existing environment variables from the .env file.
 */
function loadExistingConfig(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env');
  const envConfig: Record<string, string> = {};

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim() && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();
        if (key && value && !value.includes('_here')) {
          envConfig[key.trim()] = value;
        }
      }
    }
  }

  return envConfig;
}

/**
 * Format a date for display in the .env header.
 */
function formatDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  };
  return date.toLocaleString('en-US', options);
}

/**
 * Persist setup configuration to the project .env file.
 */
function saveConfig(envConfig: Record<string, string>, environment: string): void {
  const envPath = join(PROJECT_ROOT, '.env');
  const now = new Date();

  const marketplaceLine = envConfig.EBAY_MARKETPLACE_ID
    ? `EBAY_MARKETPLACE_ID=${envConfig.EBAY_MARKETPLACE_ID}`
    : '# EBAY_MARKETPLACE_ID=EBAY_US';
  const contentLanguageLine = envConfig.EBAY_CONTENT_LANGUAGE
    ? `EBAY_CONTENT_LANGUAGE=${envConfig.EBAY_CONTENT_LANGUAGE}`
    : '# EBAY_CONTENT_LANGUAGE=en-US';

  const content = `# eBay MCP Server Configuration
# Last Updated: ${formatDate(now)}
# Environment: ${environment}

EBAY_CLIENT_ID=${envConfig.EBAY_CLIENT_ID || ''}
EBAY_CLIENT_SECRET=${envConfig.EBAY_CLIENT_SECRET || ''}
EBAY_REDIRECT_URI=${envConfig.EBAY_REDIRECT_URI || ''}
EBAY_ENVIRONMENT=${environment}
${marketplaceLine}
${contentLanguageLine}

EBAY_USER_REFRESH_TOKEN=${envConfig.EBAY_USER_REFRESH_TOKEN || ''}
EBAY_USER_ACCESS_TOKEN=${envConfig.EBAY_USER_ACCESS_TOKEN || ''}
EBAY_APP_ACCESS_TOKEN=${envConfig.EBAY_APP_ACCESS_TOKEN || ''}
`;

  writeFileSync(envPath, content, 'utf-8');
}

async function stepWelcome(state: SetupState): Promise<StepResult> {
  clearScreen();
  showLogo();

  console.log(ui.dim('  Welcome to the eBay MCP Server setup wizard!\n'));
  console.log('  This wizard will help you:\n');
  console.log(`    ${ui.success('1.')} Choose environment (sandbox/production)`);
  console.log(`    ${ui.success('2.')} Set default marketplace and language (optional)`);
  console.log(`    ${ui.success('3.')} Configure your eBay Developer credentials`);
  console.log(`    ${ui.success('4.')} Set up OAuth authentication`);
  console.log(`    ${ui.success('5.')} Configure your MCP client (Claude, Cline, etc.)`);
  console.log(`    ${ui.success('6.')} Validate your setup\n`);

  if (state.hasExistingConfig) {
    showInfo('Existing configuration detected. You can update or keep current values.');
  }

  showKeyboardHints(['Enter: Continue', 'Ctrl+C: Exit']);

  const response = await prompts({
    type: 'confirm',
    name: 'continue',
    message: 'Ready to begin?',
    initial: true,
  });

  return response.continue !== false ? 'continue' : 'cancel';
}

/**
 * Select the eBay environment for this configuration.
 */
async function stepEnvironment(state: SetupState): Promise<StepResult> {
  clearScreen();
  showLogo();
  showProgress(1, 'Select Environment');

  console.log('  Choose which eBay environment to configure:\n');

  showBox('Environment Options', [
    '🧪 Sandbox  - For development & testing',
    '   • Free test transactions',
    '   • No real money involved',
    '   • Separate test accounts',
    '',
    '🚀 Production - For live trading',
    '   • Real transactions',
    '   • Actual eBay marketplace',
    '   • Requires approved app',
  ]);

  showTip('Start with Sandbox to test your integration safely.');

  const response = await prompts({
    type: 'select',
    name: 'environment',
    message: 'Select environment:',
    choices: [
      { title: '🧪 Sandbox (Recommended for testing)', value: 'sandbox' },
      { title: '🚀 Production (Live trading)', value: 'production' },
      { title: ui.dim('← Go back'), value: 'back' },
    ],
    initial: state.config.EBAY_ENVIRONMENT === 'production' ? 1 : 0,
  });

  if (!response.environment) return 'cancel';
  if (response.environment === 'back') return 'back';

  state.environment = response.environment;
  state.config.EBAY_ENVIRONMENT = response.environment;
  return 'continue';
}

/**
 * Configure optional marketplace and content-language defaults.
 */
async function stepMarketplaceSettings(state: SetupState): Promise<StepResult> {
  clearScreen();
  showLogo();
  showProgress(2, 'Marketplace Settings');

  if (state.isQuickMode) {
    showInfo('Quick setup enabled. Skipping optional marketplace configuration.');
    await new Promise((r) => setTimeout(r, 600));
    return 'continue';
  }

  console.log('  Configure default marketplace and language for API requests.\n');
  showBox('Marketplace Settings', [
    'These are optional defaults used for request headers.',
    'Marketplace can be overridden in many tools; language is global.',
  ]);

  const marketplaceChoices = [
    { title: ui.dim('← Go back'), value: '__back__' },
    { title: 'Skip (leave unset)', value: '' },
    ...MARKETPLACE_OPTIONS.map((option) => ({
      title: option.label,
      value: option.value,
    })),
    { title: 'Other (enter manually)', value: '__custom__' },
  ];

  const currentMarketplace = state.config.EBAY_MARKETPLACE_ID || '';
  const marketplaceDefault = currentMarketplace || 'EBAY_US';
  const marketplaceMatchIndex = marketplaceChoices.findIndex(
    (choice) => choice.value === marketplaceDefault
  );
  const marketplaceInitial =
    marketplaceMatchIndex >= 0
      ? marketplaceMatchIndex
      : marketplaceChoices.findIndex((choice) => choice.value === '__custom__');

  const marketplaceResponse = await prompts({
    type: 'select',
    name: 'marketplaceId',
    message: 'Select your default eBay marketplace:',
    choices: marketplaceChoices,
    initial: marketplaceInitial >= 0 ? marketplaceInitial : 0,
  });

  if (marketplaceResponse.marketplaceId === undefined) {
    return 'cancel';
  }
  if (marketplaceResponse.marketplaceId === '__back__') {
    return 'back';
  }

  let marketplaceId = marketplaceResponse.marketplaceId as string;
  if (marketplaceId === '__custom__') {
    const customMarketplace = await prompts({
      type: 'text',
      name: 'customMarketplaceId',
      message: 'Enter marketplace ID (e.g., EBAY_US, EBAY_DE):',
      initial: currentMarketplace || 'EBAY_US',
      validate: (value: string) =>
        value.trim().length === 0 ? 'Marketplace ID cannot be empty' : true,
    });

    if (customMarketplace.customMarketplaceId === undefined) {
      return 'cancel';
    }

    marketplaceId = customMarketplace.customMarketplaceId.trim();
  }

  if (marketplaceId) {
    state.config.EBAY_MARKETPLACE_ID = marketplaceId;
  } else {
    delete state.config.EBAY_MARKETPLACE_ID;
  }

  const languageChoices = [
    { title: ui.dim('← Go back'), value: '__back__' },
    { title: 'Skip (leave unset)', value: '' },
    ...CONTENT_LANGUAGE_OPTIONS.map((option) => ({
      title: option.label,
      value: option.value,
    })),
    { title: 'Other (enter manually)', value: '__custom__' },
  ];

  const currentLanguage = state.config.EBAY_CONTENT_LANGUAGE || '';
  const languageDefault = currentLanguage || 'en-US';
  const languageMatchIndex = languageChoices.findIndex(
    (choice) => choice.value === languageDefault
  );
  const languageInitial =
    languageMatchIndex >= 0
      ? languageMatchIndex
      : languageChoices.findIndex((choice) => choice.value === '__custom__');

  const languageResponse = await prompts({
    type: 'select',
    name: 'contentLanguage',
    message: 'Select your preferred Content-Language:',
    choices: languageChoices,
    initial: languageInitial >= 0 ? languageInitial : 0,
  });

  if (languageResponse.contentLanguage === undefined) {
    return 'cancel';
  }
  if (languageResponse.contentLanguage === '__back__') {
    return 'back';
  }

  let contentLanguage = languageResponse.contentLanguage as string;
  if (contentLanguage === '__custom__') {
    const customLanguage = await prompts({
      type: 'text',
      name: 'customContentLanguage',
      message: 'Enter Content-Language (e.g., en-US, de-DE):',
      initial: currentLanguage || 'en-US',
      validate: (value: string) =>
        value.trim().length === 0 ? 'Content-Language cannot be empty' : true,
    });

    if (customLanguage.customContentLanguage === undefined) {
      return 'cancel';
    }

    contentLanguage = customLanguage.customContentLanguage.trim();
  }

  if (contentLanguage) {
    state.config.EBAY_CONTENT_LANGUAGE = contentLanguage;
  } else {
    delete state.config.EBAY_CONTENT_LANGUAGE;
  }

  return 'continue';
}

/**
 * Collect eBay app credentials from the user.
 */
async function stepCredentials(state: SetupState): Promise<StepResult> {
  clearScreen();
  showLogo();
  showProgress(3, 'eBay Credentials');

  console.log('  Enter your eBay Developer credentials:\n');

  showTip('Get credentials at: https://developer.ebay.com/my/keys');
  showKeyboardHints(['Tab: Next field', 'Enter: Submit', 'Ctrl+C: Cancel']);

  // First ask if they want to go back
  const navChoice = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: '📝 Enter/update credentials', value: 'enter' },
      { title: ui.dim('← Go back'), value: 'back' },
    ],
    initial: 0,
  });

  if (!navChoice.action) return 'cancel';
  if (navChoice.action === 'back') return 'back';

  const responses = await prompts([
    {
      type: 'text',
      name: 'clientId',
      message: 'Client ID (App ID):',
      initial: state.config.EBAY_CLIENT_ID || '',
      validate: (v: string) => v.trim().length > 0 || 'Required',
    },
    {
      type: 'password',
      name: 'clientSecret',
      message: 'Client Secret (Cert ID):',
      initial: state.config.EBAY_CLIENT_SECRET || '',
      validate: (v: string) => v.trim().length > 0 || 'Required',
    },
    {
      type: 'text',
      name: 'redirectUri',
      message: 'Redirect URI (RuName):',
      initial: state.config.EBAY_REDIRECT_URI || '',
      validate: (v: string) => v.trim().length > 0 || 'Required',
    },
  ]);

  if (!responses.clientId) return 'cancel';

  state.config.EBAY_CLIENT_ID = responses.clientId;
  state.config.EBAY_CLIENT_SECRET = responses.clientSecret;
  state.config.EBAY_REDIRECT_URI = responses.redirectUri;

  return 'continue';
}

/**
 * Acquire and validate OAuth tokens for the configured credentials.
 */
async function stepOAuth(state: SetupState): Promise<StepResult> {
  clearScreen();
  showLogo();
  showProgress(4, 'OAuth Setup');

  console.log('  Configure user authentication for higher API rate limits:\n');

  showBox('Rate Limits by Auth Type', [
    'App Credentials Only:     1,000 req/day',
    'User Token (OAuth):    10,000-50,000 req/day',
    '',
    'User tokens require completing an OAuth flow.',
  ]);

  const hasToken = state.config.EBAY_USER_REFRESH_TOKEN?.startsWith('v^1.1#');

  if (hasToken) {
    showSuccess('Existing refresh token detected.');

    const keepToken = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: '✓ Keep and verify existing token', value: 'keep' },
        { title: '🔄 Set up new OAuth token', value: 'new' },
        { title: ui.dim('← Go back'), value: 'back' },
      ],
      initial: 0,
    });

    if (!keepToken.action) return 'cancel';
    if (keepToken.action === 'back') return 'back';

    if (keepToken.action === 'keep') {
      // Verify the existing token works by fetching user info
      console.log('\n  ' + ui.info('Verifying existing refresh token...'));
      try {
        const { accessToken, userInfo } = await verifyRefreshToken(
          state.config.EBAY_USER_REFRESH_TOKEN,
          state.config.EBAY_CLIENT_ID,
          state.config.EBAY_CLIENT_SECRET,
          state.environment
        );
        showSuccess('Refresh token verified successfully!');
        state.config.EBAY_USER_ACCESS_TOKEN = accessToken;
        displayUserInfo(userInfo);

        // Update Claude Desktop config if installed
        if (isClaudeDesktopInstalled()) {
          console.log('  ' + ui.info('Updating Claude Desktop configuration...'));
          const claudeResult = updateClaudeDesktopConfig(state.config, state.environment);
          if (claudeResult.success) {
            showSuccess('Claude Desktop config updated!');
            if (claudeResult.details) {
              showInfo(claudeResult.details);
            }
            showInfo(`Config: ${claudeResult.configPath}`);
          } else {
            showError(`Could not update Claude Desktop: ${claudeResult.error}`);
            if (claudeResult.details) {
              showInfo(claudeResult.details);
            }
          }
        } else {
          showInfo('Claude Desktop not detected. You can configure it manually later.');
        }
        console.log('');
        showKeyboardHints(['Enter: Continue to next step']);
        await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
      } catch (error) {
        const errorMsg = axios.isAxiosError(error)
          ? error.response?.data?.error_description ||
            error.response?.data?.errors?.[0]?.message ||
            error.message
          : error instanceof Error
            ? error.message
            : 'Unknown error';
        showError(`Token verification failed: ${errorMsg}`);

        // Provide specific guidance based on error type
        if (errorMsg.toLowerCase().includes('access denied')) {
          showWarning('Your token may be missing required OAuth scopes.');
          showInfo('Generating a new token via OAuth URL will include all necessary scopes.');
        } else {
          showWarning('Your existing refresh token may be expired or invalid.');
        }

        const continueAnyway = await prompts({
          type: 'confirm',
          name: 'continue',
          message: 'Would you like to set up a new OAuth token?',
          initial: true,
        });

        if (!continueAnyway.continue) {
          showInfo("Keeping existing token. You may need to re-authenticate if it doesn't work.");
          return 'continue';
        }
        // Clear invalid tokens so we fall through to OAuth setup options
        state.config.EBAY_USER_ACCESS_TOKEN = '';
        state.config.EBAY_USER_REFRESH_TOKEN = '';
      }

      if (state.config.EBAY_USER_ACCESS_TOKEN) {
        return 'continue';
      }
    }
    // User chose 'new' - fall through to OAuth setup options
  }

  // Check if we just cleared tokens due to failure (recommend OAuth URL in that case)
  const hadTokenFailure = hasToken && !state.config.EBAY_USER_REFRESH_TOKEN;

  const tokenChoice = await prompts({
    type: 'select',
    name: 'method',
    message: 'How would you like to set up OAuth?',
    choices: hadTokenFailure
      ? [
          // After token failure, prioritize OAuth URL to get fresh token with proper scopes
          { title: '🔗 Generate OAuth URL (recommended)', value: 'manual' },
          { title: '🔑 Paste authorization code (already have code)', value: 'code' },
          { title: '📝 I have a different refresh token', value: 'existing' },
          { title: '⏭️  Skip for now (1k req/day limit)', value: 'skip' },
          { title: ui.dim('← Go back'), value: 'back' },
        ]
      : [
          { title: '📝 I have a refresh token', value: 'existing' },
          { title: '🔗 Generate OAuth URL (opens browser)', value: 'manual' },
          { title: '🔑 Paste authorization code (already have code)', value: 'code' },
          { title: '⏭️  Skip for now (1k req/day limit)', value: 'skip' },
          { title: ui.dim('← Go back'), value: 'back' },
        ],
    initial: 0,
  });

  if (!tokenChoice.method) return 'cancel';
  if (tokenChoice.method === 'back') return 'back';

  if (tokenChoice.method === 'existing') {
    const tokenInput = await prompts({
      type: 'text',
      name: 'token',
      message: 'Paste your refresh token:',
      validate: (v: string) => {
        const clean = v.trim().replace(/^["']|["']$/g, '');
        if (!clean) return 'Token is required';
        if (!clean.startsWith('v^1.1#')) return 'Token should start with v^1.1#';
        return true;
      },
    });

    if (tokenInput.token) {
      const cleanToken = tokenInput.token.trim().replace(/^["']|["']$/g, '');
      state.config.EBAY_USER_REFRESH_TOKEN = cleanToken;

      // Verify the pasted token works
      console.log('\n  ' + ui.info('Verifying refresh token...'));
      try {
        const { accessToken, userInfo } = await verifyRefreshToken(
          cleanToken,
          state.config.EBAY_CLIENT_ID,
          state.config.EBAY_CLIENT_SECRET,
          state.environment
        );
        showSuccess('Refresh token verified successfully!');
        state.config.EBAY_USER_ACCESS_TOKEN = accessToken;
        displayUserInfo(userInfo);

        // Get app access token too
        console.log('  ' + ui.info('Getting app access token...'));
        try {
          const appToken = await getAppAccessToken(
            state.config.EBAY_CLIENT_ID,
            state.config.EBAY_CLIENT_SECRET,
            state.environment
          );
          state.config.EBAY_APP_ACCESS_TOKEN = appToken;
          showSuccess('App access token obtained!');
        } catch {
          showWarning('Could not get app access token (user tokens will still work).');
        }

        // Update Claude Desktop config if installed
        if (isClaudeDesktopInstalled()) {
          console.log('  ' + ui.info('Updating Claude Desktop configuration...'));
          const claudeResult = updateClaudeDesktopConfig(state.config, state.environment);
          if (claudeResult.success) {
            showSuccess('Claude Desktop config updated with credentials!');
            showInfo(`Config: ${claudeResult.configPath}`);
          } else {
            showWarning(`Could not update Claude Desktop: ${claudeResult.error}`);
          }
        }

        console.log('\n  ' + ui.success('✓') + ' OAuth setup complete!\n');
        showKeyboardHints(['Enter: Continue to next step']);
        await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
      } catch (error) {
        const errorMsg = axios.isAxiosError(error)
          ? error.response?.data?.error_description ||
            error.response?.data?.errors?.[0]?.message ||
            error.message
          : error instanceof Error
            ? error.message
            : 'Unknown error';
        showError(`Token verification failed: ${errorMsg}`);
        showWarning('The refresh token may be expired or invalid.');
        showInfo("Token saved anyway. You may need to generate a new token if it doesn't work.\n");
        showKeyboardHints(['Enter: Continue to next step']);
        await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
      }
    }
  } else if (tokenChoice.method === 'manual') {
    const authUrl = getOAuthAuthorizationUrl(
      state.config.EBAY_CLIENT_ID,
      state.config.EBAY_REDIRECT_URI,
      state.environment
    );

    console.log('\n  ' + ui.bold('OAuth Authorization URL:'));
    console.log(ui.dim('  ' + '─'.repeat(56)));
    console.log(`  ${ui.info(authUrl)}`);
    console.log(ui.dim('  ' + '─'.repeat(56)));

    // Automatically open the URL in the browser
    console.log('\n  ' + ui.info('Opening browser...'));
    try {
      await openBrowser(authUrl);
      showSuccess('Browser opened successfully!');
    } catch {
      showWarning('Could not open browser automatically. Please copy the URL above.');
    }

    console.log('\n  ' + ui.bold('Steps:'));
    console.log('  1. Sign in to your eBay account in the browser');
    console.log('  2. Grant permissions to your app');
    console.log('  3. You will be redirected - copy the URL or code parameter');
    console.log('  4. Paste it below to complete the setup\n');

    // Ask for the callback URL or code
    const codeInput = await prompts({
      type: 'text',
      name: 'code',
      message: 'Paste the callback URL or authorization code:',
      validate: (v: string) => {
        if (!v.trim()) return 'Please paste the URL or code from the callback';
        const code = parseAuthorizationCode(v);
        if (!code)
          return 'Could not find authorization code. Paste the full URL or the code parameter.';
        return true;
      },
    });

    if (!codeInput.code) {
      showWarning('OAuth setup cancelled.');
      return 'continue';
    }

    const authCode = parseAuthorizationCode(codeInput.code);
    if (!authCode) {
      showError('Could not parse authorization code.');
      return 'continue';
    }

    // Exchange code for tokens
    console.log('\n  ' + ui.info('Exchanging authorization code for tokens...'));

    try {
      const tokens = await exchangeAuthorizationCode(
        authCode,
        state.config.EBAY_CLIENT_ID,
        state.config.EBAY_CLIENT_SECRET,
        state.config.EBAY_REDIRECT_URI,
        state.environment
      );

      showSuccess('Authorization code exchanged successfully!');

      // Store all user tokens in state.config (will be saved to .env by saveConfig)
      state.config.EBAY_USER_REFRESH_TOKEN = tokens.refreshToken;
      state.config.EBAY_USER_ACCESS_TOKEN = tokens.accessToken;

      // Verify setup by fetching user info (optional - requires identity scope)
      console.log('  ' + ui.info('Verifying setup by fetching your eBay account info...'));
      try {
        const userInfo = await fetchEbayUserInfo(tokens.accessToken, state.environment);
        showSuccess('Account verified successfully!');
        displayUserInfo(userInfo);
      } catch (userError) {
        const userErrorMsg = axios.isAxiosError(userError)
          ? userError.response?.data?.errors?.[0]?.message || userError.message
          : userError instanceof Error
            ? userError.message
            : 'Unknown error';
        showWarning(`Could not fetch user info: ${userErrorMsg}`);
        if (userErrorMsg.toLowerCase().includes('access denied')) {
          showInfo(
            'This is normal if your RuName does not include the commerce.identity.readonly scope.'
          );
          showInfo('Your OAuth tokens are valid and all other APIs will work correctly.');
        } else {
          showInfo('OAuth tokens were saved successfully. You can still use the MCP server.');
        }
      }

      // Also get app access token for client credentials flow
      console.log('  ' + ui.info('Getting app access token...'));
      try {
        const appToken = await getAppAccessToken(
          state.config.EBAY_CLIENT_ID,
          state.config.EBAY_CLIENT_SECRET,
          state.environment
        );
        state.config.EBAY_APP_ACCESS_TOKEN = appToken;
        showSuccess('App access token obtained!');
      } catch {
        showWarning('Could not get app access token (user tokens will still work).');
      }

      // Update Claude Desktop config if installed
      if (isClaudeDesktopInstalled()) {
        console.log('  ' + ui.info('Updating Claude Desktop configuration...'));
        const claudeResult = updateClaudeDesktopConfig(state.config, state.environment);
        if (claudeResult.success) {
          showSuccess('Claude Desktop config updated with credentials!');
          showInfo(`Config: ${claudeResult.configPath}`);
        } else {
          showWarning(`Could not update Claude Desktop: ${claudeResult.error}`);
        }
      }

      console.log('\n  ' + ui.success('✓') + ' OAuth setup complete!');
      console.log(
        `  ${ui.dim('Access token expires in:')} ${Math.floor(tokens.expiresIn / 60)} minutes`
      );
      console.log(
        `  ${ui.dim('Refresh token expires in:')} ${Math.floor(tokens.refreshTokenExpiresIn / 60 / 60 / 24)} days`
      );
      console.log(`  ${ui.dim('All tokens will be saved to .env')}\n`);
      showKeyboardHints(['Enter: Continue to next step']);
      await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
    } catch (error) {
      const errorMsg = axios.isAxiosError(error)
        ? error.response?.data?.error_description || error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      showError(`Failed to exchange code: ${errorMsg}`);
      console.log('\n  ' + ui.dim('Common issues:'));
      console.log('  • Authorization code expired (codes are valid for ~5 minutes)');
      console.log('  • Code was already used (each code can only be used once)');
      console.log('  • Redirect URI mismatch (must match exactly what is configured in eBay)\n');

      showKeyboardHints(['Enter: Continue']);
      await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
    }
  } else if (tokenChoice.method === 'code') {
    // Direct code paste - user already has an authorization code
    console.log('\n  ' + ui.bold('Paste Authorization Code'));
    console.log(
      ui.dim(
        '  If you already completed OAuth in a browser and have the code from the callback URL.\n'
      )
    );

    const codeInput = await prompts({
      type: 'text',
      name: 'code',
      message: 'Paste the callback URL or authorization code:',
      validate: (v: string) => {
        if (!v.trim()) return 'Please paste the URL or code from the callback';
        const code = parseAuthorizationCode(v);
        if (!code)
          return 'Could not find authorization code. Paste the full URL or the code parameter.';
        return true;
      },
    });

    if (!codeInput.code) {
      showWarning('OAuth setup cancelled.');
      return 'continue';
    }

    const authCode = parseAuthorizationCode(codeInput.code);
    if (!authCode) {
      showError('Could not parse authorization code.');
      return 'continue';
    }

    // Exchange code for tokens
    console.log('\n  ' + ui.info('Exchanging authorization code for tokens...'));

    try {
      const tokens = await exchangeAuthorizationCode(
        authCode,
        state.config.EBAY_CLIENT_ID,
        state.config.EBAY_CLIENT_SECRET,
        state.config.EBAY_REDIRECT_URI,
        state.environment
      );

      showSuccess('Authorization code exchanged successfully!');

      // Store all user tokens in state.config (will be saved to .env by saveConfig)
      state.config.EBAY_USER_REFRESH_TOKEN = tokens.refreshToken;
      state.config.EBAY_USER_ACCESS_TOKEN = tokens.accessToken;

      // Verify setup by fetching user info (optional - requires identity scope)
      console.log('  ' + ui.info('Verifying setup by fetching your eBay account info...'));
      try {
        const userInfo = await fetchEbayUserInfo(tokens.accessToken, state.environment);
        showSuccess('Account verified successfully!');
        displayUserInfo(userInfo);
      } catch (userError) {
        const userErrorMsg = axios.isAxiosError(userError)
          ? userError.response?.data?.errors?.[0]?.message || userError.message
          : userError instanceof Error
            ? userError.message
            : 'Unknown error';
        showWarning(`Could not fetch user info: ${userErrorMsg}`);
        if (userErrorMsg.toLowerCase().includes('access denied')) {
          showInfo(
            'This is normal if your RuName does not include the commerce.identity.readonly scope.'
          );
          showInfo('Your OAuth tokens are valid and all other APIs will work correctly.');
        } else {
          showInfo('OAuth tokens were saved successfully. You can still use the MCP server.');
        }
      }

      // Also get app access token for client credentials flow
      console.log('  ' + ui.info('Getting app access token...'));
      try {
        const appToken = await getAppAccessToken(
          state.config.EBAY_CLIENT_ID,
          state.config.EBAY_CLIENT_SECRET,
          state.environment
        );
        state.config.EBAY_APP_ACCESS_TOKEN = appToken;
        showSuccess('App access token obtained!');
      } catch {
        showWarning('Could not get app access token (user tokens will still work).');
      }

      // Update Claude Desktop config if installed
      if (isClaudeDesktopInstalled()) {
        console.log('  ' + ui.info('Updating Claude Desktop configuration...'));
        const claudeResult = updateClaudeDesktopConfig(state.config, state.environment);
        if (claudeResult.success) {
          showSuccess('Claude Desktop config updated with credentials!');
          showInfo(`Config: ${claudeResult.configPath}`);
        } else {
          showWarning(`Could not update Claude Desktop: ${claudeResult.error}`);
        }
      }

      console.log('\n  ' + ui.success('✓') + ' OAuth setup complete!');
      console.log(
        `  ${ui.dim('Access token expires in:')} ${Math.floor(tokens.expiresIn / 60)} minutes`
      );
      console.log(
        `  ${ui.dim('Refresh token expires in:')} ${Math.floor(tokens.refreshTokenExpiresIn / 60 / 60 / 24)} days`
      );
      console.log(`  ${ui.dim('All tokens will be saved to .env')}\n`);
      showKeyboardHints(['Enter: Continue to next step']);
      await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
    } catch (error) {
      const errorMsg = axios.isAxiosError(error)
        ? error.response?.data?.error_description || error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      showError(`Failed to exchange code: ${errorMsg}`);
      console.log('\n  ' + ui.dim('Common issues:'));
      console.log('  • Authorization code expired (codes are valid for ~5 minutes)');
      console.log('  • Code was already used (each code can only be used once)');
      console.log('  • Redirect URI mismatch (must match exactly what is configured in eBay)\n');

      showKeyboardHints(['Enter: Continue']);
      await prompts({ type: 'text', name: 'continue', message: 'Press Enter to continue...' });
    }
  } else if (tokenChoice.method === 'skip') {
    showWarning("Skipping OAuth. You'll be limited to 1,000 requests/day.");
  }

  return 'continue';
}

/**
 * Configure MCP clients with the generated environment variables.
 */
async function stepMCPClients(state: SetupState): Promise<StepResult> {
  clearScreen();
  showLogo();
  showProgress(5, 'MCP Client Setup');

  console.log('  Configure your AI assistant to use the eBay MCP server:\n');

  state.detectedClients = detectLLMClients();
  const detected = state.detectedClients.filter((c) => c.detected);

  if (detected.length === 0) {
    showWarning('No supported MCP clients detected.\n');
    console.log('  Supported clients:');
    console.log('    • Claude Desktop (Anthropic)');
    console.log('    • Cline (VSCode extension)');
    console.log('    • Continue.dev (VSCode/JetBrains)\n');

    showInfo('Install one of these clients and run setup again.');

    const navChoice = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: '→ Continue to finish setup', value: 'continue' },
        { title: ui.dim('← Go back'), value: 'back' },
      ],
      initial: 0,
    });

    if (!navChoice.action) return 'cancel';
    if (navChoice.action === 'back') return 'back';
    return 'continue';
  }

  showBox(
    'Detected MCP Clients',
    detected.map((c) => {
      const status = c.configExists
        ? `${c.displayName} [Already configured]`
        : `${c.displayName} [Not configured]`;
      return status;
    })
  );

  // First ask if they want to configure or go back
  const navChoice = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: '⚙️  Configure MCP clients', value: 'configure' },
      { title: '⏭️  Skip client configuration', value: 'skip' },
      { title: ui.dim('← Go back'), value: 'back' },
    ],
    initial: 0,
  });

  if (!navChoice.action) return 'cancel';
  if (navChoice.action === 'back') return 'back';
  if (navChoice.action === 'skip') {
    showInfo('Skipping client configuration.');
    return 'continue';
  }

  const clientChoice = await prompts({
    type: 'multiselect',
    name: 'clients',
    message: 'Select clients to configure:',
    choices: detected.map((c) => ({
      title: c.displayName + (c.configExists ? chalk.yellow(' [Update]') : chalk.green(' [New]')),
      value: c.name,
      selected: !c.configExists,
    })),
    hint: 'Space: Toggle  Enter: Confirm',
    instructions: false,
  });

  if (!clientChoice.clients || clientChoice.clients.length === 0) {
    showInfo('Skipping client configuration.');
    return 'continue';
  }

  console.log('');
  for (const clientName of clientChoice.clients) {
    const client = detected.find((c) => c.name === clientName);
    if (!client) continue;

    const stopSpinner = showSpinner(`Configuring ${client.displayName}...`);
    await new Promise((r) => setTimeout(r, 500));
    const success = configureLLMClient(client, PROJECT_ROOT);
    stopSpinner();

    if (success) {
      showSuccess(`Configured ${client.displayName}`);
    } else {
      showError(`Failed to configure ${client.displayName}`);
    }
  }

  return 'continue';
}

/**
 * Finalize setup and display summary information.
 */
async function stepComplete(state: SetupState): Promise<void> {
  clearScreen();
  showLogo();
  showProgress(6, 'Setup Complete');

  const stopSpinner = showSpinner('Saving configuration...');
  await new Promise((r) => setTimeout(r, 300));
  saveConfig(state.config, state.environment);
  stopSpinner();
  showSuccess('Configuration saved to .env\n');

  console.log(ui.bold.green('\n  🎉 Setup Complete!\n'));

  showBox('Configuration Summary', [
    `Environment:     ${state.environment}`,
    `Marketplace ID:  ${state.config.EBAY_MARKETPLACE_ID || 'Not set'}`,
    `Content-Lang:    ${state.config.EBAY_CONTENT_LANGUAGE || 'Not set'}`,
    `Client ID:       ${state.config.EBAY_CLIENT_ID?.slice(0, 20)}...`,
    `Redirect URI:    ${state.config.EBAY_REDIRECT_URI?.slice(0, 30)}...`,
    `OAuth Token:     ${state.config.EBAY_USER_REFRESH_TOKEN ? '✓ Configured' : '✗ Not set'}`,
    `Rate Limit:      ${state.config.EBAY_USER_REFRESH_TOKEN ? '10k-50k/day' : '1k/day'}`,
  ]);

  console.log(ui.bold.cyan('\n  📋 Quick Reference\n'));
  console.log('  ' + ui.dim('─'.repeat(56)));
  console.log(`  ${ui.bold('Start MCP Server:')}     ${ui.info('npm start')}`);
  console.log(`  ${ui.bold('Run Diagnostics:')}      ${ui.info('npm run diagnose')}`);
  console.log(`  ${ui.bold('View Logs:')}            ${ui.info('npm run dev')}`);
  console.log(`  ${ui.bold('Run Tests:')}            ${ui.info('npm test')}`);
  console.log('  ' + ui.dim('─'.repeat(56)));

  console.log(ui.bold.cyan('\n  🚀 Next Steps\n'));
  console.log('  1. Restart your MCP client (Claude Desktop, etc.)');
  console.log('  2. The eBay server should appear in available tools');
  console.log('  3. Try: "Show my eBay seller information"\n');

  console.log(ui.dim('  Documentation: ') + ui.info('https://github.com/mrnajiboy/ebay-mcp'));
  console.log(
    ui.dim('  Get Help:      ') + ui.info('https://github.com/mrnajiboy/ebay-mcp/issues\n')
  );
}

function parseArgs(): { help: boolean; quick: boolean; diagnose: boolean } {
  const args = process.argv.slice(2);
  return {
    help: args.includes('--help') || args.includes('-h'),
    quick: args.includes('--quick') || args.includes('-q'),
    diagnose: args.includes('--diagnose') || args.includes('-d'),
  };
}

function showHelp(): void {
  console.log(`
${chalk.bold('eBay MCP Server Setup')}

${chalk.bold('Usage:')}
  npm run setup [options]

${chalk.bold('Options:')}
  --help, -h       Show this help message
  --quick, -q      Quick setup (skip optional steps)
  --diagnose, -d   Run diagnostics only

${chalk.bold('Examples:')}
  npm run setup              Full interactive wizard
  npm run setup --quick      Skip optional configuration
  npm run setup --diagnose   Check system health
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.diagnose) {
    const { runSecurityChecks, displaySecurityResults } =
      await import('../utils/security-checker.js');
    const { validateSetup, displayRecommendations } = await import('../utils/setup-validator.js');

    clearScreen();
    showLogo();
    console.log(ui.bold.cyan('  Running Diagnostics...\n'));

    const securityResults = await runSecurityChecks(PROJECT_ROOT);
    displaySecurityResults(securityResults);

    const summary = await validateSetup(PROJECT_ROOT);
    displayRecommendations(summary);

    process.exit(0);
  }

  const existingConfig = loadExistingConfig();
  const state: SetupState = {
    currentStep: 0,
    config: existingConfig,
    detectedClients: [],
    environment: (existingConfig.EBAY_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox',
    hasExistingConfig: Object.keys(existingConfig).length > 0,
    isQuickMode: args.quick,
  };

  const steps = [
    stepWelcome,
    stepEnvironment,
    stepMarketplaceSettings,
    stepCredentials,
    stepOAuth,
    stepMCPClients,
  ];

  let stepIndex = 0;
  while (stepIndex < steps.length) {
    const result = await steps[stepIndex](state);
    if (result === 'cancel') {
      console.log(ui.warning('\n  Setup cancelled.\n'));
      process.exit(0);
    } else if (result === 'back' && stepIndex > 0) {
      stepIndex--;
    } else {
      stepIndex++;
    }
  }

  await stepComplete(state);
}

process.on('SIGINT', () => {
  console.log(ui.warning('\n\n  Setup interrupted.\n'));
  process.exit(0);
});

export async function runSetup(): Promise<void> {
  await main();
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (entryPath && modulePath === entryPath) {
  runSetup().catch((error) => {
    console.error(ui.error('\n  Setup failed:'), error);
    process.exit(1);
  });
}
