import { v5 as uuidv5 } from 'uuid';

import { exchangeRateCurrencies } from '../../shared/currencies';
import { currentDay } from '../../shared/months';
import type { AccountEntity } from '../../types/models';
import * as db from '../db';
import { getExchangeRate } from '../preferences/app';

import { createPayee } from './payees';
import { calculateCurrencyRevaluation } from './revaluation-utils';

const REVALUATION_ID_NAMESPACE = '2bc9c0fe-c354-4d73-859b-e2eb6159f82a';

type RevaluationAccount = Pick<
  db.DbAccount,
  | 'id'
  | 'offbudget'
  | 'currency'
  | 'revaluation_category'
  | 'last_revaluation_check'
  | 'last_revaluation_base_currency'
  | 'last_revaluation_rate'
  | 'last_revaluation_rate_date'
  | 'exchange_rate_provider'
>;

type ExistingRevaluation = Pick<
  db.DbTransaction,
  'id' | 'date' | 'amount' | 'exchange_rate' | 'exchange_rate_date' | 'category'
>;

async function removeRevaluation(existing: ExistingRevaluation | null) {
  if (!existing) {
    return false;
  }

  await db.deleteTransaction({ id: existing.id });
  return true;
}

async function revalueAccount(
  account: RevaluationAccount,
  defaultCurrency: string,
) {
  const existing = await db.first<ExistingRevaluation>(
    `SELECT t.id, t.date, t.amount, t.exchange_rate, t.exchange_rate_date,
            cm.transferId AS category
       FROM transactions t
       LEFT JOIN category_mapping cm ON cm.id = t.category
      WHERE t.acct = ? AND t.tombstone = 0
        AND t.is_currency_revaluation = 1
      LIMIT 1`,
    [account.id],
  );
  const isSupportedCurrency = exchangeRateCurrencies.some(
    currency => currency === account.currency,
  );
  const category = account.revaluation_category
    ? await db.first<Pick<db.DbCategory, 'id'>>(
        `SELECT id FROM categories
          WHERE id = ? AND tombstone = 0 AND is_income = 0`,
        [account.revaluation_category],
      )
    : null;

  if (
    !account.currency ||
    !isSupportedCurrency ||
    account.currency === defaultCurrency ||
    (!account.offbudget && !category)
  ) {
    return removeRevaluation(existing);
  }

  const today = currentDay();
  let exchangeRate = Number(
    existing?.exchange_rate ?? account.last_revaluation_rate,
  );
  let exchangeRateDate =
    existing?.exchange_rate_date ?? account.last_revaluation_rate_date ?? null;
  let didUpdateRate = false;
  if (
    account.last_revaluation_check !== today ||
    account.last_revaluation_base_currency !== defaultCurrency ||
    !Number.isFinite(exchangeRate) ||
    exchangeRate <= 0
  ) {
    const fetchedRate = await getExchangeRate({
      source: account.currency,
      target: defaultCurrency,
      provider: account.exchange_rate_provider ?? 'frankfurter',
    });
    exchangeRate = fetchedRate.rate;
    exchangeRateDate = fetchedRate.date;
    await db.update('accounts', {
      id: account.id,
      last_revaluation_check: today,
      last_revaluation_base_currency: defaultCurrency,
      last_revaluation_rate: String(exchangeRate),
      last_revaluation_rate_date: exchangeRateDate,
    });
    didUpdateRate = true;
  }

  const balances = await db.first<{
    native_balance: number | null;
    carrying_balance: number | null;
  }>(
    `SELECT
       SUM(
         CASE
           WHEN original_currency = ? AND original_amount IS NOT NULL
             THEN original_amount
           WHEN original_currency IS NULL OR original_currency = ? THEN amount
           ELSE 0
         END
       ) AS native_balance,
       SUM(
         CASE
           WHEN original_currency = ? AND original_amount IS NOT NULL
             THEN amount
           WHEN original_currency IS NULL OR original_currency = ? THEN amount
           ELSE 0
         END
       ) AS carrying_balance
     FROM transactions
     WHERE acct = ? AND tombstone = 0 AND isParent = 0
       AND is_currency_revaluation = 0`,
    [
      account.currency,
      account.currency,
      account.currency,
      account.currency,
      account.id,
    ],
  );
  const amount = calculateCurrencyRevaluation({
    nativeBalance: balances?.native_balance ?? 0,
    carryingBalance: balances?.carrying_balance ?? 0,
    exchangeRate,
  });

  if (amount === 0) {
    return (await removeRevaluation(existing)) || didUpdateRate;
  }

  const transaction = {
    account: account.id,
    amount,
    category: account.offbudget ? null : category?.id,
    cleared: true,
    reconciled: true,
    date: today,
    notes: `Currency revaluation at ${exchangeRate} ${defaultCurrency}/${account.currency}`,
    exchange_rate: String(exchangeRate),
    exchange_rate_date: exchangeRateDate,
    is_currency_revaluation: true,
  };

  if (existing) {
    if (
      existing.amount === amount &&
      existing.date === db.toDateRepr(today) &&
      existing.category === transaction.category &&
      existing.exchange_rate === transaction.exchange_rate &&
      existing.exchange_rate_date === transaction.exchange_rate_date
    ) {
      return didUpdateRate;
    }
    await db.updateTransaction({ id: existing.id, ...transaction });
  } else {
    const payee = await createPayee('Currency Revaluation');
    await db.insertTransaction({
      id: uuidv5(account.id, REVALUATION_ID_NAMESPACE),
      payee,
      ...transaction,
    });
  }

  return true;
}

export async function revalueForeignAccounts({
  accountId,
}: {
  accountId?: AccountEntity['id'];
} = {}) {
  const defaultCurrency = await db.first<Pick<db.DbPreference, 'value'>>(
    `SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'`,
  );
  if (
    !defaultCurrency?.value ||
    !exchangeRateCurrencies.some(currency => currency === defaultCurrency.value)
  ) {
    return false;
  }

  const accounts = await db.all<RevaluationAccount>(
    `SELECT id, offbudget, currency, revaluation_category,
            last_revaluation_check, last_revaluation_base_currency,
            last_revaluation_rate, last_revaluation_rate_date,
            exchange_rate_provider
       FROM accounts
      WHERE tombstone = 0 AND closed = 0
        ${accountId ? 'AND id = ?' : ''}`,
    accountId ? [accountId] : [],
  );

  let didChange = false;
  for (const account of accounts) {
    didChange =
      (await revalueAccount(account, defaultCurrency.value)) || didChange;
  }
  return didChange;
}
