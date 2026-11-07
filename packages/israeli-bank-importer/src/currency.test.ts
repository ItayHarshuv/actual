import * as actual from '@actual-app/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mapCurrency, normalizeCurrency } from './currency.js';
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
    date: '2026-11-01T00:00:00.000Z',
    processedDate: '2026-11-01T00:00:00.000Z',
    originalAmount: -50,
    originalCurrency: 'ILS',
    chargedAmount: -50,
    chargedCurrency: 'ILS',
    description: 'Merchant',
    status: 'completed',
    ...fields,
  };
}

describe('transaction currency mapping', () => {
  beforeEach(() => {
    vi.mocked(actual.getExchangeRate).mockReset();
  });

  it('normalizes common CAL currency symbols', () => {
    expect(normalizeCurrency('₪')).toBe('ILS');
    expect(normalizeCurrency('$')).toBe('USD');
    expect(normalizeCurrency(' eur ')).toBe('EUR');
  });

  it('maps domestic transactions to the normal amount only', async () => {
    await expect(mapCurrency(transaction())).resolves.toEqual({
      amount: -5000,
      notes: undefined,
      isEstimate: false,
    });
  });

  it('stores supported pending FX in the original currency columns', async () => {
    vi.mocked(actual.getExchangeRate).mockResolvedValue({
      source: 'USD',
      target: 'ILS',
      rate: 3.7,
      date: '2026-10-31',
      isCached: false,
    });

    await expect(
      mapCurrency(
        transaction({
          status: 'pending',
          originalAmount: -25,
          originalCurrency: '$',
          chargedAmount: -25,
          chargedCurrency: undefined,
        }),
      ),
    ).resolves.toEqual({
      amount: -9250,
      original_amount: -2500,
      original_currency: 'USD',
      notes: undefined,
      exchange_rate: '3.7',
      exchange_rate_date: '2026-10-31',
      isEstimate: true,
    });
  });

  it('keeps unsupported FX out of currency columns and adds a note', async () => {
    const result = await mapCurrency(
      transaction({
        originalAmount: -1250,
        originalCurrency: 'JPY',
        chargedAmount: -31.5,
        chargedCurrency: 'ILS',
        memo: 'CAL memo',
      }),
    );

    expect(result).toMatchObject({
      amount: -3150,
      isEstimate: false,
    });
    expect(result.original_amount).toBeUndefined();
    expect(result.original_currency).toBeUndefined();
    expect(result.notes).toContain('CAL memo');
    expect(result.notes).toContain('Original amount: 1,250 JPY');
  });
});
