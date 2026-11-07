import { describe, expect, it } from 'vitest';

import {
  parseImportFromDate,
  toScrapeStartDate,
  transactionsOnOrAfter,
} from './import-from-date.js';
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

describe('parseImportFromDate', () => {
  it('accepts a calendar date', () => {
    expect(parseImportFromDate('2026-11-05')).toBe('2026-11-05');
  });

  it('leaves the cutoff unset when the field is omitted', () => {
    expect(parseImportFromDate(undefined)).toBeUndefined();
  });

  it('rejects dates that are not YYYY-MM-DD', () => {
    expect(() => parseImportFromDate('05/11/2026')).toThrow(
      'importFromDate must be a YYYY-MM-DD date',
    );
    expect(() => parseImportFromDate(20261105)).toThrow(
      'importFromDate must be a YYYY-MM-DD date',
    );
  });

  it('rejects impossible calendar dates', () => {
    expect(() => parseImportFromDate('2026-02-31')).toThrow(
      'importFromDate must be a real calendar date',
    );
  });
});

describe('toScrapeStartDate', () => {
  it('uses the start of the cutoff day', () => {
    const startDate = toScrapeStartDate('2026-11-05');

    expect(startDate.getFullYear()).toBe(2026);
    expect(startDate.getMonth()).toBe(10);
    expect(startDate.getDate()).toBe(5);
  });

  it('keeps a two-year window when no cutoff is configured', () => {
    const now = Date.parse('2026-11-07T12:00:00.000Z');

    expect(toScrapeStartDate(undefined, now).getTime()).toBe(
      now - 2 * 365 * 86_400_000,
    );
  });
});

describe('transactionsOnOrAfter', () => {
  const transactions = [
    transaction('2026-11-04T22:00:00.000Z'),
    transaction('2026-11-05'),
    transaction('2026-11-06T01:00:00.000Z'),
  ];

  it('keeps transactions on the cutoff date and later', () => {
    expect(
      transactionsOnOrAfter(transactions, '2026-11-05').map(item => item.date),
    ).toEqual(['2026-11-05', '2026-11-06T01:00:00.000Z']);
  });

  it('returns every transaction when no cutoff is configured', () => {
    expect(transactionsOnOrAfter(transactions, undefined)).toBe(transactions);
  });
});
