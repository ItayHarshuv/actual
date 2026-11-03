import { describe, expect, it, vi } from 'vitest';

import type { TransactionEntity } from 'loot-core/types/models';

import {
  convertForeignAmount,
  convertMainAmountToForeign,
  setTransactionCurrencyAmount,
} from './transactionCurrency';

const { send } = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('loot-core/platform/client/connection', () => ({ send }));

describe('setTransactionCurrencyAmount', () => {
  it('requests the rate for the transaction date', async () => {
    send.mockResolvedValue({
      source: 'EUR',
      target: 'USD',
      rate: 1.2,
      date: '2026-10-30',
      isCached: false,
    });
    const transaction: TransactionEntity = {
      id: 'transaction',
      account: 'account',
      amount: -1200,
      date: '2026-10-30',
    };

    const converted = await setTransactionCurrencyAmount(
      transaction,
      -1000,
      'EUR',
      'USD',
    );

    expect(send).toHaveBeenCalledWith('exchange-rates/get', {
      source: 'EUR',
      target: 'USD',
      date: '2026-10-30',
      provider: 'frankfurter',
    });
    expect(converted.amount).toBe(-1200);
    expect(converted.exchange_rate_date).toBe('2026-10-30');
  });

  it('preserves the direction of foreign-currency transactions', async () => {
    send.mockResolvedValue({
      source: 'EUR',
      target: 'USD',
      rate: 1.2,
      date: '2026-10-30',
      isCached: false,
    });

    const converted = await setTransactionCurrencyAmount(
      {
        id: 'transaction',
        account: 'account',
        amount: 0,
        date: '2026-10-30',
      },
      1000,
      'EUR',
      'USD',
    );

    expect(converted.original_amount).toBe(1000);
    expect(converted.amount).toBe(1200);
  });

  it('applies an account fee to expenses and supports reverse editing', () => {
    const converted = convertForeignAmount(-1000, 3.5, 2);

    expect(converted).toBe(-3570);
    expect(convertMainAmountToForeign(converted, 3.5, 2)).toBe(-1000);
  });

  it('does not apply an account fee to deposits', () => {
    expect(convertForeignAmount(1000, 3.5, 2)).toBe(3500);
  });

  it('passes the account exchange-rate provider to the server', async () => {
    await setTransactionCurrencyAmount(
      {
        id: 'transaction',
        account: 'account',
        amount: -1200,
        date: '2026-10-30',
      },
      -1000,
      'EUR',
      'ILS',
      0,
      'bank-of-israel',
    );

    expect(send).toHaveBeenLastCalledWith('exchange-rates/get', {
      source: 'EUR',
      target: 'ILS',
      date: '2026-10-30',
      provider: 'bank-of-israel',
    });
  });
});
