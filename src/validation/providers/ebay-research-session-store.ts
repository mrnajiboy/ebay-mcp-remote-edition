import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createKVStoreForBackend, type KVStore } from '@/auth/kv-store.js';

export type EbayResearchSessionStoreBackend =
  | 'cloudflare_kv'
  | 'upstash-redis'
  | 'filesystem'
  | 'none';

export interface EbayResearchSessionStoreMeta extends Record<string, unknown> {
  updatedAt?: string;
  backend?: EbayResearchSessionStoreBackend;
  marketplace?: string;
  source?: string;
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

export const EBAY_RESEARCH_STORAGE_STATE_KEY = 'ebay_research_storage_state_json';
export const EBAY_RESEARCH_STORAGE_STATE_META_KEY = 'ebay_research_storage_state_meta';
export const EBAY_RESEARCH_STORAGE_STATE_UPDATED_AT_LEGACY_KEY =
  'ebay_research_storage_state_updated_at';
export const EBAY_RESEARCH_STORAGE_STATE_SOURCE_LEGACY_KEY = 'ebay_research_storage_state_source';

const EBAY_RESEARCH_SESSION_STORE_ENV_KEY = 'EBAY_RESEARCH_SESSION_STORE';
const RESEARCH_SESSION_KEY_PREFIX = 'ebay-research:session';

let cloudflareKvSingleton: KVStore | null | undefined;
let upstashKvSingleton: KVStore | null | undefined;

function resolvePath(pathValue: string): string {
  return resolve(process.cwd(), pathValue);
}

function getResearchEnvironment(): string {
  return (process.env.EBAY_ENVIRONMENT ?? 'production').trim() || 'production';
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

export function getEbayResearchSessionLegacyKeys(marketplace: string): {
  storageStateKey: string;
  updatedAtKey: string;
  sourceKey: string;
  sessionKey: string;
} {
  const environment = getResearchEnvironment();
  return {
    storageStateKey: getScopedKey(EBAY_RESEARCH_STORAGE_STATE_KEY, marketplace),
    updatedAtKey: getScopedKey(EBAY_RESEARCH_STORAGE_STATE_UPDATED_AT_LEGACY_KEY, marketplace),
    sourceKey: getScopedKey(EBAY_RESEARCH_STORAGE_STATE_SOURCE_LEGACY_KEY, marketplace),
    sessionKey: `${RESEARCH_SESSION_KEY_PREFIX}:${environment}:${marketplace}`,
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
    return await this.kvStore.get<string>(this.stateKey);
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

  async deleteStorageState(): Promise<void> {
    await Promise.all([this.kvStore.delete(this.stateKey), this.kvStore.delete(this.metaKey)]);
  }

  async getLegacyValue<T>(key: string): Promise<T | null> {
    return await this.kvStore.get<T>(key);
  }

  async deleteLegacyKeys(keys: string[]): Promise<void> {
    await Promise.all(keys.map(async (key) => await this.kvStore.delete(key)));
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
    await mkdir(dirname(this.metaKey), { recursive: true });
    await writeFile(this.metaKey, JSON.stringify(meta, null, 2), 'utf8');
  }

  async deleteStorageState(): Promise<void> {
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

  deleteStorageState(): Promise<void> {
    return Promise.resolve();
  }
}

function getOrCreateSelectedKvStore(
  backend: Extract<EbayResearchSessionStoreBackend, 'cloudflare_kv' | 'upstash-redis'>
): KVStore {
  return createKVStoreForBackend(backend === 'cloudflare_kv' ? 'cloudflare-kv' : 'upstash-redis');
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
