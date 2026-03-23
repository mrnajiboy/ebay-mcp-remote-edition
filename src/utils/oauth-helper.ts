/**
 * OAuth Helper - Assists with eBay OAuth token acquisition
 *
 * Local HTTPS support:
 *  - Set PUBLIC_BASE_URL to your local HTTPS base (e.g. https://ebay-local.test:3000)
 *  - eBay redirects the browser to <PUBLIC_BASE_URL>/oauth/callback after authorization
 *  - EBAY_LOCAL_TLS_CERT_PATH and EBAY_LOCAL_TLS_KEY_PATH must point to mkcert-generated
 *    certificate files when PUBLIC_BASE_URL starts with "https://"
 *
 * Generating local certs with mkcert (one-time setup):
 *   brew install mkcert nss   # macOS
 *   mkcert -install           # install local CA
 *   mkcert ebay-local.test    # generates ebay-local.test.pem + ebay-local.test-key.pem
 *   # add "127.0.0.1  ebay-local.test" to /etc/hosts
 */

import chalk from 'chalk';
import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';
import type { EbayConfig } from '../types/ebay.js';
import { getOAuthAuthorizationUrl } from '../config/environment.js';

export interface OAuthCallbackResult {
  code?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Generate terminal hyperlink (if supported)
 */
function hyperlink(text: string, url: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

/**
 * Generate eBay OAuth authorization URL
 */
export function generateAuthUrl(
  clientId: string,
  redirectUri: string,
  environment: 'sandbox' | 'production',
  scopes?: string[]
): string {
  return getOAuthAuthorizationUrl(clientId, redirectUri, environment, scopes);
}

/**
 * Derive callback URL from PUBLIC_BASE_URL or fall back to a plain localhost URL.
 *
 * When PUBLIC_BASE_URL is set it is used as-is as the base for the callback
 * path.  This works for both hosted deployments and local HTTPS setups.
 * When it is not set we fall back to http://localhost:<port>/oauth/callback.
 */
export function getCallbackUrl(port = 3000): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  if (base) {
    return `${base}/oauth/callback`;
  }
  return `http://localhost:${port}/oauth/callback`;
}

/**
 * Build the HTML success page
 */
function successPage(): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>eBay MCP - Authorization Successful</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      }
      .container {
        background: white;
        padding: 40px;
        border-radius: 10px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        text-align: center;
        max-width: 500px;
      }
      .success-icon { font-size: 64px; margin-bottom: 20px; }
      h1 { color: #4CAF50; margin-bottom: 10px; }
      p { color: #666; line-height: 1.6; }
      .code {
        background: #f5f5f5;
        padding: 10px;
        border-radius: 5px;
        font-family: monospace;
        word-break: break-all;
        margin: 20px 0;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="success-icon">✅</div>
      <h1>Authorization Successful!</h1>
      <p>You have successfully authorized the eBay MCP server.</p>
      <p>You can close this window and return to your terminal.</p>
      <p class="code">Authorization code received</p>
    </div>
  </body>
</html>`;
}

/**
 * Build the HTML error page
 */
function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>eBay MCP - Authorization Failed</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      }
      .container {
        background: white;
        padding: 40px;
        border-radius: 10px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        text-align: center;
        max-width: 500px;
      }
      .error-icon { font-size: 64px; margin-bottom: 20px; }
      h1 { color: #f44336; margin-bottom: 10px; }
      p { color: #666; line-height: 1.6; }
      .error {
        background: #ffebee;
        color: #c62828;
        padding: 10px;
        border-radius: 5px;
        margin: 20px 0;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="error-icon">❌</div>
      <h1>Authorization Failed</h1>
      <p>There was an error during authorization.</p>
      <div class="error">${message}</div>
      <p>Please return to your terminal and try again.</p>
    </div>
    <script>setTimeout(() => window.close(), 5000);</script>
  </body>
</html>`;
}

/**
 * Start a local HTTP or HTTPS server to capture the OAuth callback.
 *
 * When PUBLIC_BASE_URL is set and starts with "https://" an HTTPS server is
 * started using the cert/key loaded from EBAY_LOCAL_TLS_CERT_PATH /
 * EBAY_LOCAL_TLS_KEY_PATH.  Otherwise a plain HTTP server is used.
 */
export async function startCallbackServer(
  port = 3000,
  timeout = 300000 // 5 minutes
): Promise<{ server: Server; codePromise: Promise<OAuthCallbackResult> }> {
  return await new Promise((resolve, reject) => {
    let callbackResolver: (result: OAuthCallbackResult) => void;

    const codePromise = new Promise<OAuthCallbackResult>((res) => {
      callbackResolver = res;
    });

    const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      // Use http://localhost as base for URL parsing  — scheme doesn't matter here
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(successPage());
          callbackResolver({ code });
        } else if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(errorPage(errorDescription ?? error));
          callbackResolver({ error, errorDescription: errorDescription ?? undefined });
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    };

    // Determine whether to start HTTP or HTTPS
    const publicBase = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
    const useHttps = publicBase.startsWith('https://');

    let server: Server;

    if (useHttps) {
      const certPath = process.env.EBAY_LOCAL_TLS_CERT_PATH;
      const keyPath = process.env.EBAY_LOCAL_TLS_KEY_PATH;

      if (!certPath || !keyPath) {
        reject(
          new Error(
            'PUBLIC_BASE_URL is set to an https:// URL but EBAY_LOCAL_TLS_CERT_PATH and ' +
              'EBAY_LOCAL_TLS_KEY_PATH are not set. ' +
              'Generate certs with mkcert and set these env vars.'
          )
        );
        return;
      }

      let cert: Buffer;
      let key: Buffer;
      try {
        cert = readFileSync(certPath);
        key = readFileSync(keyPath);
      } catch (err) {
        reject(
          new Error(
            `Failed to read TLS certificate/key files: ${err instanceof Error ? err.message : err}`
          )
        );
        return;
      }

      server = createHttpsServer({ cert, key }, handleRequest);
    } else {
      server = createHttpServer(handleRequest);
    }

    server.listen(port, () => {
      const scheme = useHttps ? 'https' : 'http';
      console.log(chalk.gray(`  OAuth callback server listening on ${scheme}://localhost:${port}`));
      resolve({ server, codePromise });
    });

    server.on('error', reject);

    // Timeout guard
    setTimeout(() => {
      callbackResolver({
        error: 'timeout',
        errorDescription: 'OAuth callback timeout - no response received',
      });
    }, timeout);
  });
}

/**
 * Interactive OAuth flow with local callback server.
 *
 * Uses PUBLIC_BASE_URL (when set) to determine:
 *   • The protocol (http vs https) for the local server
 *   • The host in the callback URL passed to eBay
 *   • The port to listen on
 *
 * Falls back to http://localhost:3000/oauth/callback when PUBLIC_BASE_URL is
 * not set, preserving the previous behaviour.
 */
export async function interactiveOAuthFlow(
  config: EbayConfig,
  scopes?: string[]
): Promise<string | null> {
  console.log(chalk.bold.cyan('\n🔐 Interactive OAuth Flow\n'));

  const publicBase = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

  // Determine the callback URL that eBay will redirect to after auth.
  // When PUBLIC_BASE_URL is set we use it as the base (handles both hosted
  // and local-HTTPS scenarios).  Otherwise we fall back to config.redirectUri
  // (which is the eBay RuName — not a URL) and, ultimately, localhost.
  let callbackUrl: string;
  if (publicBase) {
    callbackUrl = `${publicBase}/oauth/callback`;
  } else if (config.redirectUri?.startsWith('http')) {
    // Backward-compat: redirectUri contains an actual URL instead of a RuName
    callbackUrl = config.redirectUri;
  } else {
    callbackUrl = 'http://localhost:3000/oauth/callback';
  }

  // Extract port from the callback URL
  let port = 3000;
  try {
    const parsed = new URL(callbackUrl);
    port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    // keep default port 3000
  }

  // The RuName (config.redirectUri) is what eBay's token-exchange API expects.
  // The callback URL is what eBay redirects the browser to.
  // They are distinct: RuName → eBay internal name; callback URL → browser target.
  const ruName = config.redirectUri || callbackUrl;

  console.log(chalk.cyan('Starting local OAuth callback server...\n'));
  let server: Server;
  let codePromise: Promise<OAuthCallbackResult>;

  try {
    ({ server, codePromise } = await startCallbackServer(port));
  } catch (err) {
    console.log(
      chalk.red(
        `\n✗ Could not start callback server: ${err instanceof Error ? err.message : err}\n`
      )
    );
    return null;
  }

  // Generate the eBay authorize URL using the RuName
  const authUrl = generateAuthUrl(config.clientId, ruName, config.environment, scopes);

  console.log(chalk.bold.white('📋 Step 1: Authorize the Application\n'));
  console.log(chalk.gray('Open this URL in your browser:\n'));
  console.log(chalk.blue.underline(hyperlink(authUrl.substring(0, 60) + '...', authUrl)));
  console.log('');
  console.log(chalk.gray(`Callback will be received at: ${callbackUrl}`));
  console.log(chalk.gray('Waiting for authorization...'));
  console.log(chalk.gray('(This window will update automatically after you authorize)\n'));

  const result = await codePromise;
  server.close();

  if (result.error) {
    console.log(
      chalk.red(`\n✗ Authorization failed: ${result.errorDescription || result.error}\n`)
    );
    return null;
  }

  if (result.code) {
    console.log(chalk.green('\n✓ Authorization successful!\n'));
    return result.code;
  }

  console.log(chalk.yellow('\n⚠️  No authorization code received.\n'));
  return null;
}

/**
 * Display manual OAuth instructions
 */
export function displayManualOAuthInstructions(
  clientId: string,
  redirectUri: string,
  environment: 'sandbox' | 'production',
  scopes?: string[]
): void {
  const authUrl = generateAuthUrl(clientId, redirectUri, environment, scopes);

  console.log(chalk.bold.cyan('\n📖 Manual OAuth Token Acquisition Guide\n'));
  console.log(chalk.white('Step 1: Generate Authorization URL\n'));
  console.log(chalk.gray('Copy this URL and open it in your browser:\n'));
  console.log(chalk.blue.underline(authUrl));
  console.log('');

  console.log(chalk.white('\nStep 2: Authorize the Application\n'));
  console.log(chalk.gray('  • Log in to your eBay account'));
  console.log(chalk.gray('  • Review the permissions requested'));
  console.log(chalk.gray('  • Click "Agree" to authorize\n'));

  console.log(chalk.white('Step 3: Get the Authorization Code\n'));
  console.log(chalk.gray('  • After authorization, you will be redirected to your callback URL'));
  console.log(chalk.gray('  • The URL will contain a "code" parameter'));
  console.log(chalk.gray('  • Example: https://your-callback-url?code=v^1.1#i^1...\n'));

  console.log(chalk.white('Step 4: Exchange Code for Tokens\n'));
  console.log(chalk.gray('  • Use the code to get your refresh token'));
  console.log(chalk.gray('  • This can be done through the MCP tool: ebay_exchange_auth_code'));
  console.log(chalk.gray('  • Or paste the code in the setup wizard when prompted\n'));
}

/**
 * Get help text for RuName
 */
export function getRuNameHelp(): string {
  return `
${chalk.bold.cyan('What is a RuName?')}

A RuName (Redirect URL Name) is an eBay-generated string identifier that maps
to a registered callback URL in your eBay Developer app settings.  It is used
as the \`redirect_uri\` parameter in eBay token-exchange API calls.

${chalk.bold.white('Important distinction:')}

  ${chalk.yellow('RuName')}       — the string eBay generates (e.g. MyCompany-MyApp-PRD-abc123-xyz)
  ${chalk.yellow('Callback URL')} — the actual HTTPS URL the browser is redirected to
                 (set via PUBLIC_BASE_URL, e.g. https://ebay-local.test:3000)

${chalk.bold.white('How to create a RuName:')}

1. Go to the eBay Developer Portal:
   ${chalk.blue.underline('https://developer.ebay.com/my/keys')}

2. Select your application

3. Navigate to "User Tokens" → "Add RuName"

4. Enter your callback URL:
   ${chalk.gray('For local HTTPS: https://ebay-local.test:3000/oauth/callback')}
   ${chalk.gray('For production:  https://your-domain.com/oauth/callback')}

5. Copy the generated RuName string and put it in EBAY_RUNAME

${chalk.bold.white('Local HTTPS setup with mkcert:')}

  ${chalk.gray('brew install mkcert nss')}
  ${chalk.gray('mkcert -install')}
  ${chalk.gray('mkcert ebay-local.test')}
  ${chalk.gray('echo "127.0.0.1  ebay-local.test" | sudo tee -a /etc/hosts')}

  Then set in .env:
    PUBLIC_BASE_URL=https://ebay-local.test:3000
    EBAY_LOCAL_TLS_CERT_PATH=/path/to/ebay-local.test.pem
    EBAY_LOCAL_TLS_KEY_PATH=/path/to/ebay-local.test-key.pem

${chalk.yellow('Note:')} eBay requires HTTPS for production callback URLs.
`;
}

/**
 * Display first-time developer guide
 */
export function displayFirstTimeDeveloperGuide(): void {
  console.log(chalk.bold.cyan('\n🆕 First-Time eBay Developer Guide\n'));
  console.log(chalk.white("Welcome! Here's how to get started:\n"));

  console.log(chalk.bold.yellow('Step 1: Create eBay Developer Account\n'));
  console.log(chalk.gray('  1. Visit: ') + chalk.blue.underline('https://developer.ebay.com/'));
  console.log(chalk.gray('  2. Click "Register" or "Join"'));
  console.log(chalk.gray('  3. Complete the registration form'));
  console.log(chalk.gray('  4. Verify your email address\n'));

  console.log(chalk.bold.yellow('Step 2: Create an Application\n'));
  console.log(
    chalk.gray('  1. Go to: ') + chalk.blue.underline('https://developer.ebay.com/my/keys')
  );
  console.log(chalk.gray('  2. Click "Create Application"'));
  console.log(chalk.gray('  3. Fill in application details (name, description)'));
  console.log(chalk.gray('  4. Choose Sandbox environment to start\n'));

  console.log(chalk.bold.yellow('Step 3: Get Your Credentials\n'));
  console.log(chalk.gray('  After creating the app, you will see:'));
  console.log(chalk.gray('  • App ID (Client ID) - Copy this'));
  console.log(chalk.gray('  • Cert ID (Client Secret) - Copy this'));
  console.log(chalk.gray('  • These are needed for the setup wizard\n'));

  console.log(chalk.bold.yellow('Step 4: Create RuName (Callback URL Registration)\n'));
  console.log(chalk.gray('  1. In your application settings'));
  console.log(chalk.gray('  2. Navigate to "User Tokens" section'));
  console.log(chalk.gray('  3. Click "Add RuName"'));
  console.log(chalk.gray('  4. Enter your callback URL:'));
  console.log(chalk.gray('     Local dev: https://ebay-local.test:3000/oauth/callback'));
  console.log(chalk.gray('     Production: https://your-domain.com/oauth/callback'));
  console.log(chalk.gray('  5. Copy the generated RuName string into EBAY_RUNAME\n'));

  console.log(chalk.bold.yellow('Step 5: Set Up Local HTTPS (required by eBay)\n'));
  console.log(chalk.gray('  brew install mkcert nss'));
  console.log(chalk.gray('  mkcert -install'));
  console.log(chalk.gray('  mkcert ebay-local.test'));
  console.log(chalk.gray('  echo "127.0.0.1  ebay-local.test" | sudo tee -a /etc/hosts'));
  console.log(chalk.gray('  # Then set PUBLIC_BASE_URL, EBAY_LOCAL_TLS_CERT_PATH,'));
  console.log(chalk.gray('  # EBAY_LOCAL_TLS_KEY_PATH in your .env file\n'));

  console.log(chalk.bold.yellow('Step 6: Get User Token\n'));
  console.log(chalk.gray('  Option A: Use this setup wizard (recommended)'));
  console.log(chalk.gray('  Option B: Manual OAuth flow through eBay Developer Portal\n'));

  console.log(chalk.green.bold("✅ Once you have these, you're ready to continue!\n"));
  console.log(chalk.gray('Press Enter to continue when you have your credentials ready...'));
}
