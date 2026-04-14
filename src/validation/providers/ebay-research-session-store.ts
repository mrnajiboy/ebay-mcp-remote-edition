import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as kvStoreModule from '@/auth/kv-store.js';
import type { KVStore } from '@/auth/kv-store.js';

export type EbayResearchSessionStoreBackend =
  | 'cloudflare_kv'
  | 'upstash-redis'
  | 'filesystem'
  | 'none';

export interface EbayResearchSessionStoreMeta extends Record<string, unknown> {
  updatedAt?: string;
  expiresAt?: string | null;
  ttlSeconds?: number;
  storeTtlSeconds?: number;
  backend?: EbayResearchSessionStoreBackend;
  sessionStore?: EbayResearchSessionStoreBackend;
  marketplace?: string;
  source?: string;
  sessionVersion?: string;
  alertsSentAt?: Record<string, string>;
  sessionSource?: string | null;
  storageStateBytes?: number;
}

export interface EbayResearchSessionStoreWriteOptions {
  ttlSeconds?: number;
}

export interface EbayResearchSessionStore {
  readonly backend: EbayResearchSessionStoreBackend;
  readonly backendName: string;
  readonly stateKey: string | null;
  readonly metaKey: string | null;
  getStorageState(): Promise<string | null>;
  setStorageState(
    storageStateJson: string,
    options?: EbayResearchSessionStoreWriteOptions
  ): Promise<void>;
  getMeta(): Promise<EbayResearchSessionStoreMeta | null>;
  setMeta(
    meta: EbayResearchSessionStoreMeta,
    options?: EbayResearchSessionStoreWriteOptions
  ): Promise<void>;
  tryAcquireAlertLock(
    threshold: string,
    sessionVersion: string,
    options?: EbayResearchSessionStoreWriteOptions
  ): Promise<boolean>;
  releaseAlertLock(threshold: string, sessionVersion: string): Promise<void>;
  deleteStorageState(): Promise<void>;
}

export interface EbayResearchSessionStoreResolution {
  configured: EbayResearchSessionStoreBackend;
  selected: EbayResearchSessionStoreBackend;
  configuredFrom: 'env' | 'legacy_token_store' | 'default';
  rawConfiguredValue: string | null;
  stateKey: string | null;
  metaKey: string | null;
  store: EbayResearchSessionStore | null;
  error: string | null;
}

export interface EbayResearchSessionStoreTargetSummary {
  backend: EbayResearchSessionStoreBackend;
  backendName: string;
  connection: string | null;
  credentialsConfigured: boolean;
  credentialFingerprint: string | null;
}

export interface EbayResearchSessionStoreScopeSummary {
  environment: string;
  marketplace: string;
  stateKeyScope: 'base' | 'scoped';
}

export const EBAY_RESEARCH_STORAGE_STATE_KEY = 'ebay_research_storage_state_json';
export const EBAY_RESEARCH_STORAGE_STATE_META_KEY = 'ebay_research_storage_state_meta';

const EBAY_RESEARCH_SESSION_STORE_ENV_KEY = 'EBAY_RESEARCH_SESSION_STORE';

let cloudflareKvSingleton: KVStore | null | undefined;
let upstashKvSingleton: KVStore | null | undefined;

function resolvePath(pathValue: string): string {
  return resolve(process.cwd(), pathValue);
}

function sanitizeConnectionForDisplay(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return value;
  }
}

function getResearchEnvironment(): string {
  return (process.env.EBAY_ENVIRONMENT ?? 'production').trim() || 'production';
}

function createCredentialFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function getFilesystemStorageStatePath(): string {
  return resolvePath(
    process.env.EBAY_RESEARCH_STORAGE_STATE_PATH?.trim() ?? '.ebay-research/storage-state.json'
  );
}

function getFilesystemMetaPath(): string {
  const explicitMetaPath = process.env.EBAY_RESEARCH_STORAGE_STATE_META_PATH?.trim();
  if (explicitMetaPath && explicitMetaPath.length > 0) {
    return resolvePath(explicitMetaPath);
  }

  return `${getFilesystemStorageStatePath()}.meta.json`;
}

function getAlertLockKey(metaKey: string, threshold: string, sessionVersion: string): string {
  return `${metaKey}:alert-lock:${threshold}:${sessionVersion}`;
}

function getFilesystemAlertLockPath(
  metaPath: string,
  threshold: string,
  sessionVersion: string
): string {
  const fingerprint = createHash('sha256')
    .update(`${threshold}:${sessionVersion}`)
    .digest('hex')
    .slice(0, 24);
  return `${metaPath}.alert-lock.${fingerprint}.json`;
}

async function pruneFilesystemAlertLocks(
  metaPath: string,
  options?: { sessionVersionToKeep?: string | null }
): Promise<void> {
  const lockDirectory = dirname(metaPath);
  if (!existsSync(lockDirectory)) {
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const lockFilePrefix = `${basename(metaPath)}.alert-lock.`;
  const sessionVersionToKeep = options?.sessionVersionToKeep ?? null;

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(lockFilePrefix) && entry.endsWith('.json'))
      .map(async (entry) => {
        const lockPath = join(lockDirectory, entry);

        if (sessionVersionToKeep) {
          const lockPayload = await readJsonFile<{ sessionVersion?: string }>(lockPath);
          if (lockPayload?.sessionVersion === sessionVersionToKeep) {
            return;
          }
        }

        await rm(lockPath, { force: true });
      })
  );
}

function normalizeStoredJsonString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function getScopedKey(baseKey: string, marketplace: string): string {
  const environment = getResearchEnvironment();
  if (environment === 'production' && marketplace === 'EBAY-US') {
    return baseKey;
  }

  return `${baseKey}:${environment}:${marketplace}`;
}

export function getEbayResearchSessionStoreKeys(marketplace: string): {
  storageStateKey: string;
  metaKey: string;
} {
  return {
    storageStateKey: getScopedKey(EBAY_RESEARCH_STORAGE_STATE_KEY, marketplace),
    metaKey: getScopedKey(EBAY_RESEARCH_STORAGE_STATE_META_KEY, marketplace),
  };
}

export function getEbayResearchSessionStoreScopeSummary(
  marketplace: string
): EbayResearchSessionStoreScopeSummary {
  const environment = getResearchEnvironment();
  return {
    environment,
    marketplace,
    stateKeyScope: environment === 'production' && marketplace === 'EBAY-US' ? 'base' : 'scoped',
  };
}

function normalizeBackend(
  value: string | undefined | null
): EbayResearchSessionStoreBackend | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'cloudflare_kv':
    case 'cloudflare-kv':
    case 'cloudflare':
      return 'cloudflare_kv';
    case 'upstash-redis':
    case 'upstash-kv':
    case 'upstash_kv':
    case 'upstash_redis':
    case 'upstash':
    case 'redis':
      return 'upstash-redis';
    case 'filesystem':
    case 'file':
    case 'fs':
      return 'filesystem';
    case 'none':
    case 'off':
    case 'disabled':
    case 'noop':
      return 'none';
    default:
      return null;
  }
}

function inferBackendFromLegacyTokenStoreEnv(): EbayResearchSessionStoreBackend | null {
  const normalized = process.env.EBAY_TOKEN_STORE_BACKEND?.trim().toLowerCase();
  switch (normalized) {
    case 'cloudflare-kv':
    case 'cloudflare':
      return 'cloudflare_kv';
    case 'upstash-redis':
    case 'upstash':
    case 'redis':
      return 'upstash-redis';
    case 'memory':
    case 'in-memory':
      return 'none';
    default:
      return null;
  }
}

export function isKvEbayResearchSessionStoreBackend(
  backend: EbayResearchSessionStoreBackend
): boolean {
  return backend === 'cloudflare_kv' || backend === 'upstash-redis';
}

export function resolveEbayResearchSessionStoreBackend(): {
  configured: EbayResearchSessionStoreBackend;
  selected: EbayResearchSessionStoreBackend;
  configuredFrom: 'env' | 'legacy_token_store' | 'default';
  rawConfiguredValue: string | null;
} {
  const rawConfiguredValue = process.env[EBAY_RESEARCH_SESSION_STORE_ENV_KEY]?.trim() ?? null;
  const explicit = normalizeBackend(rawConfiguredValue);
  if (explicit) {
    return {
      configured: explicit,
      selected: explicit,
      configuredFrom: 'env',
      rawConfiguredValue,
    };
  }

  const legacy = inferBackendFromLegacyTokenStoreEnv();
  if (legacy) {
    return {
      configured: legacy,
      selected: legacy,
      configuredFrom: 'legacy_token_store',
      rawConfiguredValue,
    };
  }

  return {
    configured: 'cloudflare_kv',
    selected: 'cloudflare_kv',
    configuredFrom: 'default',
    rawConfiguredValue,
  };
}

export function getEbayResearchSessionStoreTargetSummary(
  backend: EbayResearchSessionStoreBackend = resolveEbayResearchSessionStoreBackend().selected
): EbayResearchSessionStoreTargetSummary {
  switch (backend) {
    case 'cloudflare_kv': {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
      const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID?.trim() ?? '';
      const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
      return {
        backend,
        backendName: 'cloudflare_kv',
        connection:
          accountId && namespaceId ? `account=${accountId} namespace=${namespaceId}` : null,
        credentialsConfigured: Boolean(accountId && namespaceId && apiToken),
        credentialFingerprint:
          accountId && namespaceId && apiToken
            ? createCredentialFingerprint(`${accountId}:${namespaceId}:${apiToken}`)
            : null,
      };
    }
    case 'upstash-redis': {
      const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? '';
      const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? '';
      return {
        backend,
        backendName: 'upstash-redis',
        connection: url ? sanitizeConnectionForDisplay(url) : null,
        credentialsConfigured: Boolean(url && token),
        credentialFingerprint: url && token ? createCredentialFingerprint(`${url}:${token}`) : null,
      };
    }
    case 'filesystem':
      return {
        backend,
        backendName: 'filesystem',
        connection: getFilesystemStorageStatePath(),
        credentialsConfigured: true,
        credentialFingerprint: null,
      };
    case 'none':
    default:
      return {
        backend,
        backendName: 'none',
        connection: null,
        credentialsConfigured: false,
        credentialFingerprint: null,
      };
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export abstract class KvBackedEbayResearchSessionStore implements EbayResearchSessionStore {
  readonly stateKey: string;
  readonly metaKey: string;

  protected constructor(
    readonly backend: EbayResearchSessionStoreBackend,
    readonly backendName: string,
    protected readonly kvStore: KVStore,
    marketplace: string
  ) {
    const keys = getEbayResearchSessionStoreKeys(marketplace);
    this.stateKey = keys.storageStateKey;
    this.metaKey = keys.metaKey;
  }

  async getStorageState(): Promise<string | null> {
    return normalizeStoredJsonString(await this.kvStore.get<unknown>(this.stateKey));
  }

  async setStorageState(
    storageStateJson: string,
    options?: EbayResearchSessionStoreWriteOptions
  ): Promise<void> {
    await this.kvStore.put(this.stateKey, storageStateJson, options?.ttlSeconds);
  }

  async getMeta(): Promise<EbayResearchSessionStoreMeta | null> {
    return await this.kvStore.get<EbayResearchSessionStoreMeta>(this.metaKey);
  }

  async setMeta(
    meta: EbayResearchSessionStoreMeta,
    options?: EbayResearchSessionStoreWriteOptions
  ): Promise<void> {
    await this.kvStore.put(this.metaKey, meta, options?.ttlSeconds);
  }

  async tryAcquireAlertLock(
    threshold: string,
    sessionVersion: string,
    options?: EbayResearchSessionStoreWriteOptions
  ): Promise<boolean> {
    const lockKey = getAlertLockKey(this.metaKey, threshold, sessionVersion);
    const lockPayload = {
      threshold,
      sessionVersion,
      createdAt: new Date().toISOString(),
    };

    if (typeof this.kvStore.putIfAbsent === 'function') {
      return await this.kvStore.putIfAbsent(lockKey, lockPayload, options?.ttlSeconds);
    }

    throw new Error(`Atomic alert locks are not supported for backend=${this.backend}`);
  }

  async releaseAlertLock(threshold: string, sessionVersion: string): Promise<void> {
    await this.kvStore.delete(getAlertLockKey(this.metaKey, threshold, sessionVersion));
  }

  async deleteStorageState(): Promise<void> {
    await Promise.all([this.kvStore.delete(this.stateKey), this.kvStore.delete(this.metaKey)]);
  }
}

export class CloudflareKvSessionStore extends KvBackedEbayResearchSessionStore {
  constructor(kvStore: KVStore, marketplace: string) {
    super('cloudflare_kv', 'cloudflare_kv', kvStore, marketplace);
  }
}

export class UpstashKvSessionStore extends KvBackedEbayResearchSessionStore {
  constructor(kvStore: KVStore, marketplace: string) {
    super('upstash-redis', 'upstash-redis', kvStore, marketplace);
  }
}

export class FilesystemSessionStore implements EbayResearchSessionStore {
  readonly backend = 'filesystem' as const;
  readonly backendName = 'filesystem';
  readonly stateKey = getFilesystemStorageStatePath();
  readonly metaKey = getFilesystemMetaPath();

  async getStorageState(): Promise<string | null> {
    if (!existsSync(this.stateKey)) {
      return null;
    }

    return await readFile(this.stateKey, 'utf8');
  }

  async setStorageState(storageStateJson: string): Promise<void> {
    await mkdir(dirname(this.stateKey), { recursive: true });
    await writeFile(this.stateKey, storageStateJson, 'utf8');
  }

  async getMeta(): Promise<EbayResearchSessionStoreMeta | null> {
    return await readJsonFile<EbayResearchSessionStoreMeta>(this.metaKey);
  }

  async setMeta(meta: EbayResearchSessionStoreMeta): Promise<void> {
    const previousMeta = await this.getMeta();
    await mkdir(dirname(this.metaKey), { recursive: true });
    await writeFile(this.metaKey, JSON.stringify(meta, null, 2), 'utf8');

    if (previousMeta?.sessionVersion !== meta.sessionVersion) {
      await pruneFilesystemAlertLocks(this.metaKey, {
        sessionVersionToKeep:
          typeof meta.sessionVersion === 'string' && meta.sessionVersion.length > 0
            ? meta.sessionVersion
            : null,
      });
    }
  }

  async tryAcquireAlertLock(threshold: string, sessionVersion: string): Promise<boolean> {
    const lockPath = getFilesystemAlertLockPath(this.metaKey, threshold, sessionVersion);
    await mkdir(dirname(lockPath), { recursive: true });

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            threshold,
            sessionVersion,
            createdAt: new Date().toISOString(),
          },
          null,
          2
        ),
        {
          encoding: 'utf8',
          flag: 'wx',
        }
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return false;
      }

      throw error;
    }
  }

  async releaseAlertLock(threshold: string, sessionVersion: string): Promise<void> {
    await rm(getFilesystemAlertLockPath(this.metaKey, threshold, sessionVersion), { force: true });
  }

  async deleteStorageState(): Promise<void> {
    await pruneFilesystemAlertLocks(this.metaKey);
    await Promise.all([rm(this.stateKey, { force: true }), rm(this.metaKey, { force: true })]);
  }
}

export class NoopSessionStore implements EbayResearchSessionStore {
  readonly backend = 'none' as const;
  readonly backendName = 'none';
  readonly stateKey = null;
  readonly metaKey = null;

  getStorageState(): Promise<string | null> {
    return Promise.resolve(null);
  }

  setStorageState(): Promise<void> {
    return Promise.resolve();
  }

  getMeta(): Promise<EbayResearchSessionStoreMeta | null> {
    return Promise.resolve(null);
  }

  setMeta(): Promise<void> {
    return Promise.resolve();
  }

  tryAcquireAlertLock(): Promise<boolean> {
    return Promise.resolve(false);
  }

  releaseAlertLock(): Promise<void> {
    return Promise.resolve();
  }

  deleteStorageState(): Promise<void> {
    return Promise.resolve();
  }
}

function getOrCreateSelectedKvStore(
  backend: Extract<EbayResearchSessionStoreBackend, 'cloudflare_kv' | 'upstash-redis'>
): KVStore {
  const explicitBackend = backend === 'cloudflare_kv' ? 'cloudflare-kv' : 'upstash-redis';

  if (typeof kvStoreModule.createKVStoreForBackend === 'function') {
    return kvStoreModule.createKVStoreForBackend(explicitBackend);
  }

  return kvStoreModule.createKVStore();
}

function createFreshSelectedKvStore(
  backend: Extract<EbayResearchSessionStoreBackend, 'cloudflare_kv' | 'upstash-redis'>
): KVStore {
  const explicitBackend = backend === 'cloudflare_kv' ? 'cloudflare-kv' : 'upstash-redis';

  if (typeof kvStoreModule.createFreshKVStoreForBackend === 'function') {
    return kvStoreModule.createFreshKVStoreForBackend(explicitBackend);
  }

  return getOrCreateSelectedKvStore(backend);
}

function getCloudflareSingleton(): KVStore {
  cloudflareKvSingleton ??= getOrCreateSelectedKvStore('cloudflare_kv');

  return cloudflareKvSingleton;
}

function getUpstashSingleton(): KVStore {
  upstashKvSingleton ??= getOrCreateSelectedKvStore('upstash-redis');

  return upstashKvSingleton;
}

export function createEbayResearchSessionStoreResolution(
  marketplace: string
): EbayResearchSessionStoreResolution {
  const backend = resolveEbayResearchSessionStoreBackend();
  const keys = getEbayResearchSessionStoreKeys(marketplace);

  try {
    switch (backend.selected) {
      case 'cloudflare_kv':
        return {
          ...backend,
          stateKey: keys.storageStateKey,
          metaKey: keys.metaKey,
          store: new CloudflareKvSessionStore(getCloudflareSingleton(), marketplace),
          error: null,
        };
      case 'upstash-redis':
        return {
          ...backend,
          stateKey: keys.storageStateKey,
          metaKey: keys.metaKey,
          store: new UpstashKvSessionStore(getUpstashSingleton(), marketplace),
          error: null,
        };
      case 'filesystem': {
        const store = new FilesystemSessionStore();
        return {
          ...backend,
          stateKey: store.stateKey,
          metaKey: store.metaKey,
          store,
          error: null,
        };
      }
      case 'none':
      default:
        return {
          ...backend,
          stateKey: null,
          metaKey: null,
          store: null,
          error: null,
        };
    }
  } catch (error) {
    return {
      ...backend,
      stateKey:
        backend.selected === 'filesystem' ? getFilesystemStorageStatePath() : keys.storageStateKey,
      metaKey: backend.selected === 'filesystem' ? getFilesystemMetaPath() : keys.metaKey,
      store: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createFreshEbayResearchSessionStoreResolution(
  marketplace: string
): EbayResearchSessionStoreResolution {
  const backend = resolveEbayResearchSessionStoreBackend();
  const keys = getEbayResearchSessionStoreKeys(marketplace);

  try {
    switch (backend.selected) {
      case 'cloudflare_kv':
        return {
          ...backend,
          stateKey: keys.storageStateKey,
          metaKey: keys.metaKey,
          store: new CloudflareKvSessionStore(
            createFreshSelectedKvStore('cloudflare_kv'),
            marketplace
          ),
          error: null,
        };
      case 'upstash-redis':
        return {
          ...backend,
          stateKey: keys.storageStateKey,
          metaKey: keys.metaKey,
          store: new UpstashKvSessionStore(
            createFreshSelectedKvStore('upstash-redis'),
            marketplace
          ),
          error: null,
        };
      case 'filesystem': {
        const store = new FilesystemSessionStore();
        return {
          ...backend,
          stateKey: store.stateKey,
          metaKey: store.metaKey,
          store,
          error: null,
        };
      }
      case 'none':
      default:
        return {
          ...backend,
          stateKey: null,
          metaKey: null,
          store: null,
          error: null,
        };
    }
  } catch (error) {
    return {
      ...backend,
      stateKey:
        backend.selected === 'filesystem' ? getFilesystemStorageStatePath() : keys.storageStateKey,
      metaKey: backend.selected === 'filesystem' ? getFilesystemMetaPath() : keys.metaKey,
      store: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
