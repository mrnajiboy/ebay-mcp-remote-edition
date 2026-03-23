import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

function isHostedEnvironment(): boolean {
  return (
    process.env.RENDER === 'true' ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.VERCEL === '1' ||
    process.env.K_SERVICE !== undefined ||
    process.env.AWS_EXECUTION_ENV !== undefined
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error('Usage: tsx src/scripts/run-with-local-env.ts <command> [args...]');
  }

  const hosted = isHostedEnvironment();
  const [command, ...commandArgs] = args;

  const finalCommand = hosted ? command : 'npx';
  const finalArgs = hosted
    ? commandArgs
    : // --overload ensures .env values always win over any pre-set shell env vars
      // (e.g. a stale EBAY_TOKEN_STORE_BACKEND exported in .zshrc from a previous run)
      ['-y', '@dotenvx/dotenvx', 'run', '--overload', '--', command, ...commandArgs];

  console.log(
    hosted
      ? '[env-launcher] Hosted environment detected, using platform-provided env vars'
      : '[env-launcher] Local environment detected, loading env via dotenvx'
  );

  const child = spawn(finalCommand, finalArgs, {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (entryPath && modulePath === entryPath) {
  main().catch((error) => {
    console.error('[env-launcher] Failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}