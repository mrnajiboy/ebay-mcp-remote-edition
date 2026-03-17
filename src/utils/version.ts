import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import updateNotifier from 'update-notifier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, '../../package.json');

interface PackageJson {
  name: string;
  version: string;
  [key: string]: unknown;
}

let cachedPackageJson: PackageJson | null = null;

export function getPackageJson(): PackageJson {
  if (cachedPackageJson) {
    return cachedPackageJson;
  }

  try {
    const content = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
    cachedPackageJson = JSON.parse(content) as PackageJson;
    return cachedPackageJson;
  } catch {
    return { name: 'ebay-mcp', version: '0.0.0' };
  }
}

export function getVersion(): string {
  return getPackageJson().version;
}

export function getPackageName(): string {
  return getPackageJson().name;
}

const ONE_DAY_MS = 1000 * 60 * 60 * 24;

export function checkForUpdates(options: { defer?: boolean } = {}): void {
  const pkg = getPackageJson();

  const notifier = updateNotifier({
    pkg,
    updateCheckInterval: ONE_DAY_MS,
  });

  notifier.notify({
    isGlobal: true,
    defer: options.defer ?? false,
    message:
      'Update available {currentVersion} → {latestVersion}\n' + 'Run {updateCommand} to update',
  });
}

export async function getUpdateInfo(): Promise<
  { current: string; latest: string; name: string } | undefined
> {
  const pkg = getPackageJson();

  const notifier = updateNotifier({
    pkg,
    updateCheckInterval: 0,
  });

  await notifier.fetchInfo();

  if (notifier.update && notifier.update.latest !== pkg.version) {
    return {
      current: pkg.version,
      latest: notifier.update.latest,
      name: pkg.name,
    };
  }

  return undefined;
}
