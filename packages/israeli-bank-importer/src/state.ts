import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PendingState } from './types.js';

const EMPTY_STATE: PendingState = { version: 1, records: {} };

export class PendingStateStore {
  private readonly filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'pending-state.json');
  }

  async load(): Promise<PendingState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      const state = JSON.parse(contents) as PendingState;
      if (state.version !== 1 || !state.records) {
        throw new Error('Unsupported pending state format');
      }
      return state;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  async save(state: PendingState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
