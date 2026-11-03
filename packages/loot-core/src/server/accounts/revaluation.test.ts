import { describe, expect, it } from 'vitest';

import { calculateCurrencyRevaluation } from './revaluation-utils';

describe('calculateCurrencyRevaluation', () => {
  it('records a loss when the foreign currency weakens', () => {
    expect(
      calculateCurrencyRevaluation({
        nativeBalance: 100_000,
        carryingBalance: 350_000,
        exchangeRate: 3,
      }),
    ).toBe(-50_000);
  });

  it('records a gain when the foreign currency strengthens', () => {
    expect(
      calculateCurrencyRevaluation({
        nativeBalance: 100_000,
        carryingBalance: 300_000,
        exchangeRate: 3.5,
      }),
    ).toBe(50_000);
  });

  it('offsets the carrying value when the native balance reaches zero', () => {
    expect(
      calculateCurrencyRevaluation({
        nativeBalance: 0,
        carryingBalance: 12_500,
        exchangeRate: 3.5,
      }),
    ).toBe(-12_500);
  });
});
