import { CompanyTypes } from '@tomerh2001/israeli-bank-scrapers';
import { describe, expect, it } from 'vitest';

import { selectTransactionsForImport } from './transaction-limit.js';
import type { SourceTransaction } from './types.js';

function transaction(date: string): SourceTransaction {
  return {
    type: 'normal',
    date,
    processedDate: date,
    originalAmount: -1,
    originalCurrency: 'ILS',
    chargedAmount: -1,
    chargedCurrency: 'ILS',
    description: date,
    status: 'completed',
  };
}

describe('selectTransactionsForImport', () => {
  it('keeps only the 10 most recent Hapoalim transactions', () => {
    const transactions = Array.from({ length: 12 }, (_, index) =>
      transaction(`2026-01-${String(index + 1).padStart(2, '0')}`),
    );

    const selected = selectTransactionsForImport(
      CompanyTypes.hapoalim,
      transactions,
    );

    expect(selected).toHaveLength(10);
    expect(selected.map(item => item.date)).toEqual([
      '2026-01-12',
      '2026-01-11',
      '2026-01-10',
      '2026-01-09',
      '2026-01-08',
      '2026-01-07',
      '2026-01-06',
      '2026-01-05',
      '2026-01-04',
      '2026-01-03',
    ]);
  });

  it('does not limit other banks', () => {
    const transactions = Array.from({ length: 12 }, (_, index) =>
      transaction(`2026-01-${String(index + 1).padStart(2, '0')}`),
    );

    expect(
      selectTransactionsForImport(CompanyTypes.visaCal, transactions),
    ).toBe(transactions);
  });
});
