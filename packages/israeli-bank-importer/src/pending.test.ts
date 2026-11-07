import { CompanyTypes } from '@tomerh2001/israeli-bank-scrapers';
import { describe, expect, it } from 'vitest';

import {
  completedImportedId,
  findPendingMatch,
  isPastGracePeriod,
  pendingFingerprint,
} from './pending.js';
import type { PendingRecord, SourceTransactionWithContext } from './types.js';

function context(
  fields: Partial<SourceTransactionWithContext['transaction']> = {},
  companyId:
    | CompanyTypes.hapoalim
    | CompanyTypes.visaCal = CompanyTypes.visaCal,
): SourceTransactionWithContext {
  return {
    companyId,
    sourceAccountNumber: '1234',
    actualAccountId: 'actual-account',
    transaction: {
      type: 'normal',
      date: '2026-11-01T00:00:00.000Z',
      processedDate: '2026-11-01T00:00:00.000Z',
      originalAmount: -25,
      originalCurrency: 'USD',
      chargedAmount: -92.5,
      chargedCurrency: 'ILS',
      description: 'Coffee Shop',
      status: 'pending',
      ...fields,
    },
  };
}

function record(
  source: SourceTransactionWithContext,
  fields: Partial<PendingRecord> = {},
): PendingRecord {
  const fingerprint = pendingFingerprint(source);
  return {
    fingerprint,
    actualTransactionId: 'transaction-id',
    actualAccountId: source.actualAccountId,
    companyId: source.companyId,
    sourceAccountNumber: source.sourceAccountNumber,
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    lastSeenAt: '2026-11-01T00:00:00.000Z',
    transactionDate: source.transaction.date.slice(0, 10),
    description: source.transaction.description,
    originalAmount: source.transaction.originalAmount,
    originalCurrency: source.transaction.originalCurrency,
    sourceIdentifier:
      source.transaction.identifier == null
        ? undefined
        : String(source.transaction.identifier),
    ...fields,
  };
}

describe('pending transaction identity', () => {
  it('creates stable IDs while distinguishing identical occurrences', () => {
    const source = context();
    expect(pendingFingerprint(source)).toBe(pendingFingerprint(source));
    expect(pendingFingerprint(source, 1)).not.toBe(pendingFingerprint(source));
    expect(completedImportedId(source)).toBe(completedImportedId(source));
  });

  it('matches Hapoalim settlement by bank reference', () => {
    const pending = context(
      { identifier: 'bank-reference' },
      CompanyTypes.hapoalim,
    );
    const completed = context(
      {
        identifier: 'bank-reference',
        status: 'completed',
        chargedAmount: -25,
      },
      CompanyTypes.hapoalim,
    );

    expect(findPendingMatch(completed, [record(pending)])).toEqual(
      record(pending),
    );
  });

  it('matches CAL settlement by card, merchant, date, amount, and currency', () => {
    const pending = context();
    const completed = context({
      date: '2026-11-04T00:00:00.000Z',
      status: 'completed',
      identifier: 'cal-final-id',
      description: '  COFFEE-shop ',
    });

    expect(findPendingMatch(completed, [record(pending)])?.fingerprint).toBe(
      record(pending).fingerprint,
    );
  });

  it('does not match a different amount', () => {
    const pending = context();
    const completed = context({
      status: 'completed',
      originalAmount: -26,
    });

    expect(findPendingMatch(completed, [record(pending)])).toBeUndefined();
  });

  it('expires absent pending records only after seven days', () => {
    const pending = record(context());
    expect(
      isPastGracePeriod(pending, new Date('2026-11-07T23:59:59.000Z'), 7),
    ).toBe(false);
    expect(
      isPastGracePeriod(pending, new Date('2026-11-08T00:00:00.000Z'), 7),
    ).toBe(true);
  });
});
