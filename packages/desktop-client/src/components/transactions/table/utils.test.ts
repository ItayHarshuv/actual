import { describe, expect, it } from 'vitest';

import type { TransactionEntity } from 'loot-core/types/models';

import { deserializeTransaction, serializeTransaction } from './utils';

const transaction: TransactionEntity = {
  id: 'transaction',
  account: 'account',
  amount: -3650,
  date: '2026-11-01',
};

describe('transaction currency serialization', () => {
  it('keeps the main and foreign amounts in separate editable fields', () => {
    const serialized = serializeTransaction({
      ...transaction,
      original_amount: -1000,
      original_currency: 'USD',
      exchange_rate: '3.65',
      exchange_rate_date: '2026-10-30',
    });

    expect(serialized.debit).toBe('36.50');
    expect(serialized.credit).toBe('');
    expect(serialized.foreignAmount).toBe('10.00');
    expect(serialized.amount).toBe(-3650);
  });

  it('keeps the foreign-currency metadata when deserializing', () => {
    const original = {
      ...transaction,
      original_amount: -1000,
      original_currency: 'USD',
      exchange_rate: '3.65',
      exchange_rate_date: '2026-10-30',
    };

    const deserialized = deserializeTransaction(
      {
        ...serializeTransaction(original),
        debit: '40.00',
        foreignAmount: '12.50',
      },
      original,
    );

    expect(deserialized.amount).toBe(-4000);
    expect(deserialized.original_currency).toBe('USD');
    expect(deserialized.exchange_rate_date).toBe('2026-10-30');
  });
});
