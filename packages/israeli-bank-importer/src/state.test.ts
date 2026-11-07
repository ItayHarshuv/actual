import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareStorage } from './state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { force: true, recursive: true })),
  );
});

describe('prepareStorage', () => {
  it('creates runtime directories on an empty mounted volume', async () => {
    const storageDir = await mkdtemp(
      path.join(tmpdir(), 'actual-israeli-importer-'),
    );
    temporaryDirectories.push(storageDir);

    const directories = await prepareStorage(storageDir);

    expect((await stat(directories.actualDataDir)).isDirectory()).toBe(true);
    expect((await stat(directories.chromeDataDir)).isDirectory()).toBe(true);
  });
});
