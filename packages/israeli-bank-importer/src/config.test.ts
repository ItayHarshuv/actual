import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

function configEnv(importFromDate?: string): NodeJS.ProcessEnv {
  return {
    ISRAELI_BANK_IMPORTER_CONFIG: JSON.stringify({
      actual: {
        serverURL: 'https://actual.example',
        password: 'secret',
        syncId: 'sync-id',
      },
      banks: [
        {
          companyId: 'hapoalim',
          credentials: { userCode: 'user', password: 'pass' },
          targets: [
            { actualAccountId: 'account', sourceAccountNumbers: 'all' },
          ],
        },
      ],
      ...(importFromDate ? { importFromDate } : {}),
    }),
  };
}

describe('loadConfig importFromDate', () => {
  it('reads the cutoff from the importer JSON', () => {
    expect(loadConfig(configEnv('2026-11-05')).importFromDate).toBe(
      '2026-11-05',
    );
  });

  it('leaves the cutoff unset when the JSON omits it', () => {
    expect(loadConfig(configEnv()).importFromDate).toBeUndefined();
  });

  it('rejects an invalid cutoff before the worker starts', () => {
    expect(() => loadConfig(configEnv('November 5'))).toThrow(
      'importFromDate must be a YYYY-MM-DD date',
    );
  });
});
