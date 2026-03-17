import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type { StoredTokenData } from '@/types/ebay.js';
import { authLogger } from '@/utils/logger.js';

interface PersistedTokenState {
  userTokens: StoredTokenData | null;
  appAccessToken?: string | null;
  appAccessTokenExpiry?: number;
  updatedAt: string;
}

function defaultTokenStorePath(): string {
  return process.env.EBAY_TOKEN_STORE_PATH || resolve(process.cwd(), '.ebay-user-tokens.json');
}

export class EbayTokenStore {
  constructor(private readonly filePath: string = defaultTokenStorePath()) {}

  getPath(): string {
    return this.filePath;
  }

  load(): PersistedTokenState | null {
    try {
      if (!existsSync(this.filePath)) {
        return null;
      }

      const raw = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as PersistedTokenState;
    } catch (error) {
      authLogger.error('Failed to load token store', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  save(state: PersistedTokenState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            ...state,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (error) {
      authLogger.error('Failed to save token store', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export type { PersistedTokenState };
