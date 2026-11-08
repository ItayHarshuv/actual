import * as actual from '@actual-app/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mapCurrency } from './currency.js';
import {
  toTransactionFields,
  toTransactionUpdate,
} from './transaction-fields.js';
import type { SourceTransaction } from './types.js';

vi.mock('@actual-app/api', () => ({
  exchangeRateCurrencies: ['ILS', 'USD', 'EUR'],
  getExchangeRate: vi.fn(),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
  },
}));

function transaction(
  fields: Partial<SourceTransaction> = {},
): SourceTransaction {
  return {
    type: 'normal',
    date: '2026-11-08T00:00:00.000Z',
    processedDate: '2026-11-08T00:00:00.000Z',
    originalAmount: -50,
    originalCurrency: 'ILS',
    chargedAmount: -50,
    chargedCurrency: 'ILS',
    description: 'Merchant',
    status: 'pending',
    ...fields,
  };
}

function expectDefinedValues(fields: object) {
  for (const [key, value] of Object.entries(fields)) {
    expect(value, key).not.toBeUndefined();
  }
}

describe('transaction update fields', () => {
  beforeEach(() => {
    vi.mocked(actual.getExchangeRate).mockReset();
  });

  it('omits unset currency and note fields for a domestic update', async () => {
    const source = transaction();
    const fields = toTransactionUpdate(
      toTransactionFields(
        source,
        await mapCurrency(source),
        'pending-fingerprint',
      ),
    );

    expect(fields).toEqual({
      date: '2026-11-08',
      amount: -5000,
      imported_payee: 'Merchant',
      imported_id: 'pending-fingerprint',
      cleared: false,
    });
    expect(fields).not.toHaveProperty('payee_name');
    expectDefinedValues(fields);
  });

  it('keeps an estimated exchange rate on a pending foreign update', async () => {
    vi.mocked(actual.getExchangeRate).mockResolvedValue({
      source: 'USD',
      target: 'ILS',
      rate: 3.7,
      date: '2026-11-07',
      isCached: false,
    });
    const source = transaction({
      originalAmount: -25,
      originalCurrency: 'USD',
      chargedAmount: -25,
      chargedCurrency: undefined,
      memo: 'Card memo',
    });

    const fields = toTransactionUpdate(
      toTransactionFields(source, await mapCurrency(source), 'pending-usd'),
    );

    expect(fields).toMatchObject({
      amount: -9250,
      original_amount: -2500,
      original_currency: 'USD',
      exchange_rate: '3.7',
      exchange_rate_date: '2026-11-07',
      notes: 'Card memo',
      cleared: false,
    });
    expectDefinedValues(fields);
  });

  it('omits the exchange rate when a foreign charge already settled in ILS', async () => {
    const source = transaction({
      status: 'completed',
      originalAmount: -25,
      originalCurrency: 'USD',
      chargedAmount: -93.4,
      chargedCurrency: 'ILS',
    });

    const fields = toTransactionUpdate(
      toTransactionFields(source, await mapCurrency(source), 'settled-usd'),
    );

    expect(fields).toMatchObject({
      amount: -9340,
      original_amount: -2500,
      original_currency: 'USD',
      cleared: true,
    });
    expect(fields).not.toHaveProperty('exchange_rate');
    expect(fields).not.toHaveProperty('exchange_rate_date');
    expect(fields).not.toHaveProperty('notes');
    expectDefinedValues(fields);
    expect(actual.getExchangeRate).not.toHaveBeenCalled();
  });
});
