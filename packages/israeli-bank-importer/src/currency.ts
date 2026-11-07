import * as actual from '@actual-app/api';

import type { ImportTransactionEntity } from '@actual-app/core/types/models';

import type { SourceTransaction } from './types.js';

const currencyAliases = new Map([
  ['₪', 'ILS'],
  ['ש"ח', 'ILS'],
  ['שח', 'ILS'],
  ['$', 'USD'],
  ['US$', 'USD'],
  ['€', 'EUR'],
]);

const supportedTransactionCurrencies = new Set<string>(
  actual.exchangeRateCurrencies,
);

export type CurrencyMapping = Pick<
  ImportTransactionEntity,
  'amount' | 'original_amount' | 'original_currency' | 'notes'
> & {
  exchange_rate?: string;
  exchange_rate_date?: string;
  isEstimate: boolean;
};

export function normalizeCurrency(value: string | undefined): string {
  if (!value) {
    return 'ILS';
  }
  const trimmed = value.trim();
  return currencyAliases.get(trimmed) ?? trimmed.toUpperCase();
}

function appendOriginalAmountNote(
  notes: string | undefined,
  amount: number,
  currency: string,
  isEstimate: boolean,
): string {
  const originalAmount = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 3,
  }).format(Math.abs(amount));
  const lines = [
    notes?.trim(),
    `Original amount: ${originalAmount} ${currency}`,
    isEstimate ? 'ILS amount is an estimate until settlement.' : undefined,
  ].filter(Boolean);
  return lines.join('\n');
}

async function getEstimatedRate(
  source: string,
  date: string,
  provider: 'frankfurter' | 'bank-of-israel',
): Promise<{ rate: number; date: string } | undefined> {
  try {
    if (supportedTransactionCurrencies.has(source)) {
      return await actual.getExchangeRate({
        source,
        target: 'ILS',
        date,
        provider,
      });
    }

    const response = await fetch(
      `https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(source)}&quotes=ILS&from=${date}&to=${date}`,
    );
    if (!response.ok) {
      return undefined;
    }
    const rates = (await response.json()) as Array<{
      date: string;
      rate: number;
    }>;
    const rate = rates[0];
    return rate && Number.isFinite(rate.rate) && rate.rate > 0
      ? rate
      : undefined;
  } catch {
    return undefined;
  }
}

export async function mapCurrency(
  transaction: SourceTransaction,
  exchangeRateProvider: 'frankfurter' | 'bank-of-israel' = 'bank-of-israel',
): Promise<CurrencyMapping> {
  const originalCurrency = normalizeCurrency(transaction.originalCurrency);
  const chargedCurrency = normalizeCurrency(transaction.chargedCurrency);
  const isForeign = originalCurrency !== 'ILS';
  const date = transaction.date.slice(0, 10);

  if (!isForeign) {
    return {
      amount: actual.utils.amountToInteger(transaction.chargedAmount),
      notes: transaction.memo,
      isEstimate: false,
    };
  }

  const hasFinalIlsAmount =
    transaction.status === 'completed' && chargedCurrency === 'ILS';
  let ilsAmount = hasFinalIlsAmount ? transaction.chargedAmount : undefined;
  let exchangeRate: { rate: number; date: string } | undefined;

  if (ilsAmount == null) {
    exchangeRate = await getEstimatedRate(
      originalCurrency,
      date,
      exchangeRateProvider,
    );
    if (exchangeRate) {
      ilsAmount = transaction.originalAmount * exchangeRate.rate;
    }
  }

  const isEstimate = !hasFinalIlsAmount;
  if (ilsAmount == null) {
    ilsAmount = transaction.originalAmount;
    console.warn(
      `No ILS conversion was available for ${originalCurrency}; using the source numeric amount until settlement`,
    );
  }

  if (supportedTransactionCurrencies.has(originalCurrency)) {
    return {
      amount: actual.utils.amountToInteger(ilsAmount),
      original_amount: actual.utils.amountToInteger(transaction.originalAmount),
      original_currency: originalCurrency,
      notes: transaction.memo,
      exchange_rate: exchangeRate ? String(exchangeRate.rate) : undefined,
      exchange_rate_date: exchangeRate?.date,
      isEstimate,
    };
  }

  return {
    amount: actual.utils.amountToInteger(ilsAmount),
    notes: appendOriginalAmountNote(
      transaction.memo,
      transaction.originalAmount,
      originalCurrency,
      isEstimate,
    ),
    isEstimate,
  };
}
