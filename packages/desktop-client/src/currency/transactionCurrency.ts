import { send } from 'loot-core/platform/client/connection';
import { getCurrency } from 'loot-core/shared/currencies';
import { integerToAmount } from 'loot-core/shared/util';
import type { IntegerAmount } from 'loot-core/shared/util';
import type { AccountEntity, TransactionEntity } from 'loot-core/types/models';

export const transactionCurrencyCodes = ['ILS', 'USD', 'EUR'] as const;

export function isTransactionCurrency(
  code: string | undefined,
): code is (typeof transactionCurrencyCodes)[number] {
  return transactionCurrencyCodes.some(currency => currency === code);
}

export async function setTransactionCurrencyAmount(
  transaction: TransactionEntity,
  originalAmount: IntegerAmount,
  originalCurrency: string,
  defaultCurrency: string,
  conversionFeePercent = 0,
  exchangeRateProvider: NonNullable<
    AccountEntity['exchange_rate_provider']
  > = 'frankfurter',
): Promise<TransactionEntity> {
  const exchangeRate = await send('exchange-rates/get', {
    source: originalCurrency,
    target: defaultCurrency,
    date: transaction.date,
    provider: exchangeRateProvider,
  });

  return {
    ...transaction,
    amount: convertForeignAmount(
      originalAmount,
      exchangeRate.rate,
      conversionFeePercent,
    ),
    original_amount: originalAmount,
    original_currency: originalCurrency,
    exchange_rate: String(exchangeRate.rate),
    exchange_rate_date: exchangeRate.date,
  };
}

export function convertForeignAmount(
  originalAmount: IntegerAmount,
  exchangeRate: number,
  conversionFeePercent: number,
): IntegerAmount {
  const feeMultiplier =
    originalAmount < 0 ? 1 + Math.max(conversionFeePercent, 0) / 100 : 1;
  return Math.round(originalAmount * exchangeRate * feeMultiplier);
}

export function convertMainAmountToForeign(
  amount: IntegerAmount,
  exchangeRate: number,
  conversionFeePercent: number,
): IntegerAmount {
  const feeMultiplier =
    amount < 0 ? 1 + Math.max(conversionFeePercent, 0) / 100 : 1;
  return Math.round(amount / exchangeRate / feeMultiplier);
}

export function clearTransactionCurrency(
  transaction: TransactionEntity,
): TransactionEntity {
  return {
    ...transaction,
    original_amount: null,
    original_currency: null,
    exchange_rate: null,
    exchange_rate_date: null,
  };
}

export function formatOriginalAmount(transaction: TransactionEntity): string {
  if (transaction.original_amount == null || !transaction.original_currency) {
    return '';
  }

  const currency = getCurrency(transaction.original_currency);
  const amount = integerToAmount(
    transaction.original_amount,
    currency.decimalPlaces,
  );
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: transaction.original_currency,
    minimumFractionDigits: currency.decimalPlaces,
    maximumFractionDigits: currency.decimalPlaces,
  }).format(amount);
}
