import { describe, expect, it } from 'vitest';

import { toUpdateFields } from './update-fields.js';

describe('transaction update fields', () => {
  it('drops undefined currency and note fields before updating a domestic transaction', () => {
    expect(
      toUpdateFields({
        date: '2026-11-08',
        amount: -5000,
        original_amount: undefined,
        original_currency: undefined,
        exchange_rate: undefined,
        exchange_rate_date: undefined,
        payee_name: 'Merchant',
        imported_payee: 'Merchant',
        notes: undefined,
        imported_id: 'pending-1',
        cleared: false,
      }),
    ).toEqual({
      date: '2026-11-08',
      amount: -5000,
      imported_payee: 'Merchant',
      imported_id: 'pending-1',
      cleared: false,
    });
  });

  it('keeps a settled foreign amount without sending an undefined exchange rate', () => {
    expect(
      toUpdateFields({
        date: '2026-11-08',
        amount: -9250,
        original_amount: -2500,
        original_currency: 'USD',
        exchange_rate: undefined,
        exchange_rate_date: undefined,
        payee_name: 'Coffee Shop',
        imported_payee: 'Coffee Shop',
        notes: 'CAL memo',
        imported_id: 'completed-1',
        cleared: true,
      }),
    ).toEqual({
      date: '2026-11-08',
      amount: -9250,
      original_amount: -2500,
      original_currency: 'USD',
      imported_payee: 'Coffee Shop',
      notes: 'CAL memo',
      imported_id: 'completed-1',
      cleared: true,
    });
  });
});
