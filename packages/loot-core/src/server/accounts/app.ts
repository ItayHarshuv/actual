import { t } from 'i18next';
import { v4 as uuidv4 } from 'uuid';

import type { ImportTransactionsOpts } from '#types/api-handlers';
import { captureException } from '../../platform/exceptions';
import * as asyncStorage from '../../platform/server/asyncStorage';
import * as connection from '../../platform/server/connection';
import { logger } from '../../platform/server/log';
import { exchangeRateCurrencies } from '../../shared/currencies';
import { isNonProductionEnvironment } from '../../shared/environment';
import { dayFromDate } from '../../shared/months';
import * as monthUtils from '../../shared/months';
import { amountToInteger } from '../../shared/util';
import type {
  AccountEntity,
  CategoryEntity,
  GoCardlessToken,
  ImportTransactionEntity,
  SyncServerGoCardlessAccount,
  SyncServerPluggyAiAccount,
  SyncServerSimpleFinAccount,
  TransactionEntity,
} from '../../types/models';
import { createApp } from '../app';
import * as db from '../db';
import {
  APIError,
  BankSyncError,
  PostError,
  TransactionError,
} from '../errors';
import { app as mainApp, send as sendMain } from '../main-app';
import { mutator } from '../mutators';
import { get, post } from '../post';
import { getExchangeRate } from '../preferences/app';
import { getServer } from '../server-config';
import { batchMessages } from '../sync';
import { undoable, withUndo } from '../undo';

import * as link from './link';
import { getStartingBalancePayee } from './payees';
import { revalueForeignAccounts } from './revaluation';
import * as bankSync from './sync';

// Shared base type for link account parameters
type LinkAccountBaseParams = {
  upgradingId?: AccountEntity['id'];
  offBudget?: boolean;
  startingDate?: string;
  startingBalance?: number;
};

export type AccountHandlers = {
  'account-update': typeof updateAccount;
  'accounts-get': typeof getAccounts;
  'account-balance': typeof getAccountBalance;
  'account-properties': typeof getAccountProperties;
  'accounts-revalue': typeof revalueAccounts;
  'gocardless-accounts-link': typeof linkGoCardlessAccount;
  'simplefin-accounts-link': typeof linkSimpleFinAccount;
  'pluggyai-accounts-link': typeof linkPluggyAiAccount;
  'account-create': typeof createAccount;
  'account-close': typeof closeAccount;
  'account-reopen': typeof reopenAccount;
  'account-move': typeof moveAccount;
  'secret-set': typeof setSecret;
  'secret-check': typeof checkSecret;
  'gocardless-poll-web-token': typeof pollGoCardlessWebToken;
  'gocardless-poll-web-token-stop': typeof stopGoCardlessWebTokenPolling;
  'gocardless-status': typeof goCardlessStatus;
  'simplefin-status': typeof simpleFinStatus;
  'pluggyai-status': typeof pluggyAiStatus;
  'simplefin-accounts': typeof simpleFinAccounts;
  'pluggyai-accounts': typeof pluggyAiAccounts;
  'gocardless-get-banks': typeof getGoCardlessBanks;
  'gocardless-create-web-token': typeof createGoCardlessWebToken;
  'accounts-bank-sync': typeof accountsBankSync;
  'simplefin-batch-sync': typeof simpleFinBatchSync;
  'transactions-import': typeof importTransactions;
  'account-unlink': typeof unlinkAccount;
};

async function updateAccount({
  id,
  name,
  last_reconciled,
  conversion_fee_percent,
  exchange_rate_provider,
  currency,
  revaluation_category,
}: Pick<AccountEntity, 'id' | 'name'> &
  Partial<
    Pick<
      AccountEntity,
      | 'last_reconciled'
      | 'conversion_fee_percent'
      | 'exchange_rate_provider'
      | 'currency'
      | 'revaluation_category'
    >
  >) {
  const existingAccount = await db.first<db.DbAccount>(
    'SELECT * FROM accounts WHERE id = ?',
    [id],
  );
  const conversionFeePercent =
    conversion_fee_percent == null
      ? undefined
      : Math.min(Math.max(conversion_fee_percent, 0), 100);
  const exchangeRateProvider =
    exchange_rate_provider === 'bank-of-israel'
      ? 'bank-of-israel'
      : exchange_rate_provider === 'frankfurter'
        ? 'frankfurter'
        : undefined;
  const accountCurrency =
    currency === undefined
      ? undefined
      : currency === null ||
          exchangeRateCurrencies.some(candidate => candidate === currency)
        ? currency
        : null;
  const hasCurrencyChange =
    accountCurrency !== undefined &&
    accountCurrency !== (existingAccount?.currency ?? null);
  const hasProviderChange =
    exchangeRateProvider !== undefined &&
    exchangeRateProvider !==
      (existingAccount?.exchange_rate_provider ?? 'frankfurter');
  const hasRevaluationCategoryChange =
    revaluation_category !== undefined &&
    revaluation_category !== (existingAccount?.revaluation_category ?? null);
  await db.update('accounts', {
    id,
    name,
    ...(last_reconciled && { last_reconciled }),
    ...(conversionFeePercent !== undefined && {
      conversion_fee_percent: conversionFeePercent,
    }),
    ...(exchangeRateProvider !== undefined && {
      exchange_rate_provider: exchangeRateProvider,
    }),
    ...(accountCurrency !== undefined && { currency: accountCurrency }),
    ...(revaluation_category !== undefined && { revaluation_category }),
    ...((hasCurrencyChange ||
      hasProviderChange ||
      hasRevaluationCategoryChange) && {
      last_revaluation_check: null,
    }),
  });

  if (
    conversionFeePercent !== undefined ||
    exchangeRateProvider !== undefined
  ) {
    const transactions = await db.all<
      Pick<
        db.DbTransaction,
        | 'id'
        | 'date'
        | 'original_amount'
        | 'original_currency'
        | 'exchange_rate'
      >
    >(
      `SELECT id, date, original_amount, original_currency, exchange_rate
       FROM transactions
       WHERE acct = ? AND tombstone = 0 AND original_amount IS NOT NULL
         AND original_currency IS NOT NULL`,
      [id],
    );
    const defaultCurrency = await db.first<Pick<db.DbPreference, 'value'>>(
      `SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'`,
    );
    const effectiveFeePercent =
      conversionFeePercent ?? existingAccount?.conversion_fee_percent ?? 0;
    const effectiveProvider =
      exchangeRateProvider ??
      existingAccount?.exchange_rate_provider ??
      'frankfurter';
    const fetchedRates = new Map<string, { rate: number; date: string }>();

    for (const transaction of transactions) {
      let exchangeRate = Number(transaction.exchange_rate);
      let exchangeRateDate: string | undefined;
      if (
        exchangeRateProvider !== undefined &&
        transaction.original_currency &&
        defaultCurrency?.value
      ) {
        const transactionDate = db.fromDateRepr(transaction.date);
        const cacheKey = `${transaction.original_currency}:${defaultCurrency.value}:${transactionDate}`;
        let fetchedRate = fetchedRates.get(cacheKey);
        if (!fetchedRate) {
          try {
            fetchedRate = await getExchangeRate({
              source: transaction.original_currency,
              target: defaultCurrency.value,
              date: transactionDate,
              provider: effectiveProvider,
            });
            fetchedRates.set(cacheKey, fetchedRate);
          } catch (error) {
            logger.warn('Unable to recalculate transaction exchange rate', {
              transactionId: transaction.id,
              error,
            });
          }
        }
        if (fetchedRate) {
          exchangeRate = fetchedRate.rate;
          exchangeRateDate = fetchedRate.date;
        }
      }

      if (
        transaction.original_amount != null &&
        Number.isFinite(exchangeRate) &&
        exchangeRate > 0
      ) {
        await db.update('transactions', {
          id: transaction.id,
          amount: Math.round(
            transaction.original_amount *
              exchangeRate *
              (transaction.original_amount < 0
                ? 1 + effectiveFeePercent / 100
                : 1),
          ),
          ...(exchangeRateDate && {
            exchange_rate: String(exchangeRate),
            exchange_rate_date: exchangeRateDate,
          }),
        });
      }
    }
  }

  if (hasCurrencyChange || hasProviderChange || hasRevaluationCategoryChange) {
    try {
      if (await revalueForeignAccounts({ accountId: id })) {
        connection.send('sync-event', {
          type: 'success',
          tables: ['accounts', 'transactions'],
        });
      }
    } catch (error) {
      logger.warn('Unable to revalue foreign-currency account', {
        accountId: id,
        error,
      });
    }
  }
  return {};
}

async function getAccounts(): Promise<AccountEntity[]> {
  const dbAccounts = await db.getAccounts();
  const revaluations = await db.all<
    Pick<
      db.DbTransaction,
      'acct' | 'amount' | 'exchange_rate' | 'exchange_rate_date'
    >
  >(
    `SELECT acct, amount, exchange_rate, exchange_rate_date
       FROM transactions
      WHERE tombstone = 0 AND is_currency_revaluation = 1`,
  );
  const revaluationsByAccount = new Map(
    revaluations.map(revaluation => [revaluation.acct, revaluation]),
  );
  const nativeBalances = await db.all<{
    id: db.DbAccount['id'];
    balance: number | null;
  }>(
    `SELECT a.id,
            SUM(
              CASE
                WHEN t.original_currency = a.currency
                     AND t.original_amount IS NOT NULL
                  THEN t.original_amount
                WHEN t.original_currency IS NULL
                     OR t.original_currency = a.currency
                  THEN t.amount
                ELSE 0
              END
            ) AS balance
       FROM accounts a
       LEFT JOIN transactions t
         ON t.acct = a.id AND t.tombstone = 0 AND t.isParent = 0
            AND t.is_currency_revaluation = 0
      WHERE a.tombstone = 0 AND a.currency IS NOT NULL
      GROUP BY a.id`,
  );
  const nativeBalancesByAccount = new Map(
    nativeBalances.map(({ id, balance }) => [id, balance ?? 0]),
  );
  return dbAccounts.map(dbAccount => {
    const revaluation = revaluationsByAccount.get(dbAccount.id);
    return {
      id: dbAccount.id,
      name: dbAccount.name,
      offbudget: dbAccount.offbudget,
      closed: dbAccount.closed,
      sort_order: dbAccount.sort_order,
      last_reconciled: dbAccount.last_reconciled ?? null,
      tombstone: dbAccount.tombstone,
      account_id: dbAccount.account_id ?? null,
      bank: dbAccount.bank ?? null,
      bankName: dbAccount.bankName ?? null,
      bankId: dbAccount.bankId ?? null,
      mask: dbAccount.mask ?? null,
      official_name: dbAccount.official_name ?? null,
      balance_current: dbAccount.balance_current ?? null,
      balance_available: dbAccount.balance_available ?? null,
      balance_limit: dbAccount.balance_limit ?? null,
      account_sync_source: dbAccount.account_sync_source ?? null,
      last_sync: dbAccount.last_sync ?? null,
      conversion_fee_percent: dbAccount.conversion_fee_percent ?? 0,
      exchange_rate_provider: dbAccount.exchange_rate_provider ?? 'frankfurter',
      currency: dbAccount.currency ?? null,
      revaluation_category: dbAccount.revaluation_category ?? null,
      last_revaluation_check: dbAccount.last_revaluation_check ?? null,
      currency_revaluation_amount: revaluation?.amount ?? 0,
      currency_revaluation_rate:
        revaluation?.exchange_rate ?? dbAccount.last_revaluation_rate ?? null,
      currency_revaluation_date:
        revaluation?.exchange_rate_date ??
        dbAccount.last_revaluation_rate_date ??
        null,
      currency_native_balance: nativeBalancesByAccount.get(dbAccount.id) ?? 0,
    } satisfies AccountEntity;
  });
}

async function revalueAccounts({
  accountId,
}: {
  accountId?: AccountEntity['id'];
} = {}) {
  const didChange = await revalueForeignAccounts({ accountId });
  if (didChange) {
    connection.send('sync-event', {
      type: 'success',
      tables: ['accounts', 'transactions'],
    });
  }
  return { didChange };
}

async function getAccountBalance({
  id,
  cutoff,
}: {
  id: string;
  cutoff: string | Date;
}) {
  const result = await db.first<{ balance: number }>(
    'SELECT sum(amount) as balance FROM transactions WHERE acct = ? AND isParent = 0 AND tombstone = 0 AND date <= ?',
    [id, db.toDateRepr(dayFromDate(cutoff))],
  );
  return result?.balance ? result.balance : 0;
}

async function getAccountProperties({ id }: { id: AccountEntity['id'] }) {
  const balanceResult = await db.first<{ balance: number }>(
    'SELECT sum(amount) as balance FROM transactions WHERE acct = ? AND isParent = 0 AND tombstone = 0',
    [id],
  );
  const countResult = await db.first<{ count: number }>(
    'SELECT count(id) as count FROM transactions WHERE acct = ? AND tombstone = 0',
    [id],
  );

  return {
    balance: balanceResult?.balance || 0,
    numTransactions: countResult?.count || 0,
  };
}

async function linkGoCardlessAccount({
  requisitionId,
  account,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  requisitionId: string;
  account: SyncServerGoCardlessAccount;
}) {
  let id;
  const bank = await link.findOrCreateBank(account.institution, requisitionId);

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: account.account_id,
      bank: bank.id,
      account_sync_source: 'goCardless',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: account.account_id,
      mask: account.mask,
      name: account.name,
      official_name: account.official_name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'goCardless',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    account.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions'],
  });

  return 'ok';
}

async function linkSimpleFinAccount({
  externalAccount,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  externalAccount: SyncServerSimpleFinAccount;
}) {
  let id;

  const institution = {
    name: externalAccount.institution ?? t('Unknown'),
  };

  const bank = await link.findOrCreateBank(
    institution,
    externalAccount.orgDomain ?? externalAccount.orgId,
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: externalAccount.account_id,
      bank: bank.id,
      account_sync_source: 'simpleFin',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: externalAccount.account_id,
      name: externalAccount.name,
      official_name: externalAccount.name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    externalAccount.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions'],
  });

  return 'ok';
}

async function linkPluggyAiAccount({
  externalAccount,
  upgradingId,
  offBudget = false,
  startingDate,
  startingBalance,
}: LinkAccountBaseParams & {
  externalAccount: SyncServerPluggyAiAccount;
}) {
  let id;

  const institution = {
    name: externalAccount.institution ?? t('Unknown'),
  };

  const bank = await link.findOrCreateBank(
    institution,
    externalAccount.orgDomain ?? externalAccount.orgId,
  );

  if (upgradingId) {
    const accRow = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [upgradingId],
    );

    if (!accRow) {
      throw new Error(`Account with ID ${upgradingId} not found.`);
    }

    id = accRow.id;
    await db.update('accounts', {
      id,
      account_id: externalAccount.account_id,
      bank: bank.id,
      account_sync_source: 'pluggyai',
    });
  } else {
    id = uuidv4();
    await db.insertWithUUID('accounts', {
      id,
      account_id: externalAccount.account_id,
      name: externalAccount.name,
      official_name: externalAccount.name,
      bank: bank.id,
      offbudget: offBudget ? 1 : 0,
      account_sync_source: 'pluggyai',
    });
    await db.insertPayee({
      name: '',
      transfer_acct: id,
    });
  }

  await bankSync.syncAccount(
    undefined,
    undefined,
    id,
    externalAccount.account_id,
    bank.bank_id,
    startingDate,
    startingBalance,
  );

  connection.send('sync-event', {
    type: 'success',
    tables: ['transactions'],
  });

  return 'ok';
}

async function createAccount({
  name,
  balance = 0,
  offBudget = false,
  closed = false,
  currency,
  revaluationCategory,
}: {
  name: string;
  balance?: number | undefined;
  offBudget?: boolean | undefined;
  closed?: boolean | undefined;
  currency?: string | null;
  revaluationCategory?: CategoryEntity['id'] | null;
}) {
  const defaultCurrency = await db.first<Pick<db.DbPreference, 'value'>>(
    `SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'`,
  );
  const accountCurrency =
    currency &&
    currency !== defaultCurrency?.value &&
    exchangeRateCurrencies.some(candidate => candidate === currency)
      ? currency
      : null;
  const id: AccountEntity['id'] = await db.insertAccount({
    name,
    offbudget: offBudget ? 1 : 0,
    closed: closed ? 1 : 0,
    currency: accountCurrency,
    revaluation_category:
      accountCurrency && !offBudget ? revaluationCategory : null,
  });

  await db.insertPayee({
    name: '',
    transfer_acct: id,
  });

  if (balance != null && balance !== 0) {
    const payee = await getStartingBalancePayee();
    const nativeAmount = amountToInteger(balance);
    let convertedAmount = nativeAmount;
    let exchangeRate: Awaited<ReturnType<typeof getExchangeRate>> | null = null;
    if (accountCurrency && defaultCurrency?.value) {
      try {
        exchangeRate = await getExchangeRate({
          source: accountCurrency,
          target: defaultCurrency.value,
        });
        convertedAmount = Math.round(nativeAmount * exchangeRate.rate);
        await db.update('accounts', {
          id,
          last_revaluation_check: monthUtils.currentDay(),
          last_revaluation_base_currency: defaultCurrency.value,
          last_revaluation_rate: String(exchangeRate.rate),
          last_revaluation_rate_date: exchangeRate.date,
        });
      } catch (error) {
        logger.warn('Unable to convert foreign starting balance', {
          accountId: id,
          error,
        });
      }
    }

    await db.insertTransaction({
      account: id,
      amount: convertedAmount,
      category: offBudget ? null : payee.category,
      payee: payee.id,
      date: monthUtils.currentDay(),
      cleared: true,
      starting_balance_flag: true,
      ...(accountCurrency && {
        original_amount: nativeAmount,
        original_currency: accountCurrency,
      }),
      ...(exchangeRate && {
        exchange_rate: String(exchangeRate.rate),
        exchange_rate_date: exchangeRate.date,
      }),
    });
  }

  if (accountCurrency) {
    try {
      await revalueForeignAccounts({ accountId: id });
    } catch (error) {
      logger.warn('Unable to revalue newly created account', {
        accountId: id,
        error,
      });
    }
  }

  return id;
}

async function closeAccount({
  id,
  transferAccountId,
  categoryId,
  forced = false,
}: {
  id: AccountEntity['id'];
  transferAccountId?: AccountEntity['id'] | undefined;
  categoryId?: CategoryEntity['id'] | undefined;
  forced?: boolean | undefined;
}) {
  // Unlink the account if it's linked. This makes sure to remove it from
  // bank-sync providers. (This should not be undo-able, as it mutates the
  // remote server and the user will have to link the account again)
  await unlinkAccount({ id });

  return withUndo(async () => {
    const account = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ? AND tombstone = 0',
      [id],
    );

    // Do nothing if the account doesn't exist or it's already been
    // closed
    if (!account || account.closed === 1) {
      return;
    }

    const { balance, numTransactions } = await getAccountProperties({ id });

    // If there are no transactions, we can simply delete the account
    if (numTransactions === 0) {
      await db.deleteAccount({ id });
    } else if (forced) {
      const rows = db.runQuery<
        Pick<db.DbViewTransaction, 'id' | 'transfer_id'>
      >(
        'SELECT id, transfer_id FROM v_transactions WHERE account = ?',
        [id],
        true,
      );

      const transferPayee = await db.first<Pick<db.DbPayee, 'id'>>(
        'SELECT id FROM payees WHERE transfer_acct = ?',
        [id],
      );

      if (!transferPayee) {
        throw new Error(`Transfer payee with account ID ${id} not found.`);
      }

      await batchMessages(async () => {
        // TODO: what this should really do is send a special message that
        // automatically marks the tombstone value for all transactions
        // within an account... or something? This is problematic
        // because another client could easily add new data that
        // should be marked as deleted.

        rows.forEach(row => {
          if (row.transfer_id) {
            void db.updateTransaction({
              id: row.transfer_id,
              payee: null,
              transfer_id: null,
            });
          }

          void db.deleteTransaction({ id: row.id });
        });

        void db.deleteAccount({ id });
        void db.deleteTransferPayee({ id: transferPayee.id });
      });
    } else {
      if (balance !== 0 && transferAccountId == null) {
        throw APIError('balance is non-zero: transferAccountId is required');
      }

      if (id === transferAccountId) {
        throw APIError('transfer account can not be the account being closed');
      }

      await db.update('accounts', { id, closed: 1 });

      // If there is a balance we need to transfer it to the specified
      // account (and possibly categorize it)
      if (balance !== 0 && transferAccountId) {
        const transferPayee = await db.first<Pick<db.DbPayee, 'id'>>(
          'SELECT id FROM payees WHERE transfer_acct = ?',
          [transferAccountId],
        );

        if (!transferPayee) {
          throw new Error(
            `Transfer payee with account ID ${transferAccountId} not found.`,
          );
        }

        await mainApp.handlers['transaction-add']({
          id: uuidv4(),
          payee: transferPayee.id,
          amount: -balance,
          account: id,
          date: monthUtils.currentDay(),
          notes: 'Closing account',
          category: categoryId,
        });
      }
    }
  });
}

async function reopenAccount({ id }: { id: AccountEntity['id'] }) {
  await db.update('accounts', { id, closed: 0 });
}

async function moveAccount({
  id,
  targetId,
}: {
  id: AccountEntity['id'];
  targetId: AccountEntity['id'] | null;
}) {
  await db.moveAccount(id, targetId);
}

async function setSecret({
  name,
  value,
}: {
  name: string;
  value: string | null;
}) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.BASE_SERVER + '/secret',
      {
        name,
        value,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );
  } catch (error) {
    return {
      error: 'failed',
      reason: error instanceof PostError ? error.reason : undefined,
    };
  }
}
async function checkSecret(name: string) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await get(serverConfig.BASE_SERVER + '/secret/' + name, {
      'X-ACTUAL-TOKEN': userToken,
    });
  } catch (error) {
    logger.error(error);
    return { error: 'failed' };
  }
}

let stopPolling = false;

async function pollGoCardlessWebToken({
  requisitionId,
}: {
  requisitionId: string;
}) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return { error: 'unknown' };

  const startTime = Date.now();
  stopPolling = false;

  async function getData(
    cb: (
      data:
        | { status: 'timeout' }
        | { status: 'unknown'; message?: string }
        | { status: 'success'; data: GoCardlessToken },
    ) => void,
  ) {
    if (stopPolling) {
      return;
    }

    if (Date.now() - startTime >= 1000 * 60 * 10) {
      cb({ status: 'timeout' });
      return;
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('Failed to get server config.');
    }

    const data = await post(
      serverConfig.GOCARDLESS_SERVER + '/get-accounts',
      {
        requisitionId,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );

    if (data) {
      if (data.error_code) {
        logger.error('Failed linking gocardless account:', data);
        cb({ status: 'unknown', message: data.error_type });
      } else {
        cb({ status: 'success', data });
      }
    } else {
      setTimeout(() => getData(cb), 3000);
    }
  }

  return new Promise(resolve => {
    void getData(data => {
      if (data.status === 'success') {
        resolve({ data: data.data });
        return;
      }

      if (data.status === 'timeout') {
        resolve({ error: data.status });
        return;
      }

      resolve({
        error: data.status,
        message: data.message,
      });
    });
  });
}

async function stopGoCardlessWebTokenPolling() {
  stopPolling = true;
  return 'ok';
}

async function goCardlessStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.GOCARDLESS_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function simpleFinStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.SIMPLEFIN_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function pluggyAiStatus() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.PLUGGYAI_SERVER + '/status',
    {},
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function simpleFinAccounts() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.SIMPLEFIN_SERVER + '/accounts',
      {},
      {
        'X-ACTUAL-TOKEN': userToken,
      },
      60000,
    );
  } catch {
    return { error_code: 'TIMED_OUT' };
  }
}

async function pluggyAiAccounts() {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.PLUGGYAI_SERVER + '/accounts',
      {},
      {
        'X-ACTUAL-TOKEN': userToken,
      },
      60000,
    );
  } catch {
    return { error_code: 'TIMED_OUT' };
  }
}

async function getGoCardlessBanks(country: string) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return post(
    serverConfig.GOCARDLESS_SERVER + '/get-banks',
    { country, showDemo: isNonProductionEnvironment() },
    {
      'X-ACTUAL-TOKEN': userToken,
    },
  );
}

async function createGoCardlessWebToken({
  institutionId,
  accessValidForDays,
}: {
  institutionId: string;
  accessValidForDays: number;
}) {
  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return { error: 'unauthorized' };
  }

  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  try {
    return await post(
      serverConfig.GOCARDLESS_SERVER + '/create-web-token',
      {
        institutionId,
        accessValidForDays,
      },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );
  } catch (error) {
    logger.error(error);
    return { error: 'failed' };
  }
}

type SyncResponse = {
  newTransactions: Array<TransactionEntity['id']>;
  matchedTransactions: Array<TransactionEntity['id']>;
  updatedAccounts: Array<AccountEntity['id']>;
};

async function handleSyncResponse(
  res: {
    added: Array<TransactionEntity['id']>;
    updated: Array<TransactionEntity['id']>;
  },
  acct: db.DbAccount,
): Promise<SyncResponse> {
  const { added, updated } = res;
  const newTransactions: Array<TransactionEntity['id']> = [];
  const matchedTransactions: Array<TransactionEntity['id']> = [];
  const updatedAccounts: Array<AccountEntity['id']> = [];

  newTransactions.push(...added);
  matchedTransactions.push(...updated);

  if (added.length > 0) {
    updatedAccounts.push(acct.id);
  }

  const ts = new Date().getTime().toString();
  await db.update('accounts', { id: acct.id, last_sync: ts });

  return {
    newTransactions,
    matchedTransactions,
    updatedAccounts,
  };
}

type SyncError =
  | {
      type: 'SyncError';
      accountId: AccountEntity['id'];
      message: string;
      category: string;
      code: string;
    }
  | {
      accountId: AccountEntity['id'];
      message: string;
      internal?: string;
    };

/**
 * Type guard to check if an error is a BankSyncError.
 * Handles both class instances and plain objects with the BankSyncError shape.
 */
function isBankSyncError(err: unknown): err is BankSyncError {
  return (
    err instanceof BankSyncError ||
    (typeof err === 'object' &&
      err !== null &&
      'type' in err &&
      err.type === 'BankSyncError')
  );
}

/**
 * Converts a sync error into a standardized SyncError response object.
 */
function handleSyncError(
  err: Error | PostError | BankSyncError,
  acct: db.DbAccount,
): SyncError {
  if (isBankSyncError(err)) {
    const syncError = {
      type: 'SyncError',
      accountId: acct.id,
      message: 'Failed syncing account "' + acct.name + '."',
      category: err.category,
      code: err.code,
    };

    if (err.category === 'RATE_LIMIT_EXCEEDED') {
      return {
        ...syncError,
        message: `Failed syncing account ${acct.name}. Rate limit exceeded. Please try again later.`,
      };
    }

    return syncError;
  }

  if (err instanceof PostError && err.reason !== 'internal') {
    return {
      accountId: acct.id,
      message: err.reason
        ? err.reason
        : `Account "${acct.name}" is not linked properly. Please link it again.`,
    };
  }

  return {
    accountId: acct.id,
    message:
      'There was an internal error. Please get in touch https://actualbudget.org/contact for support.',
    internal: err.stack,
  };
}

export type SyncResponseWithErrors = SyncResponse & {
  errors: SyncError[];
};

async function accountsBankSync({
  ids = [],
}: {
  ids: Array<AccountEntity['id']>;
}): Promise<SyncResponseWithErrors> {
  const { 'user-id': userId, 'user-key': userKey } =
    await asyncStorage.multiGet(['user-id', 'user-key']);

  const accounts = db.runQuery<db.DbAccount & { bankId: db.DbBank['bank_id'] }>(
    `
    SELECT a.*, b.bank_id as bankId
    FROM accounts a
    LEFT JOIN banks b ON a.bank = b.id
    WHERE a.tombstone = 0 AND a.closed = 0
      ${ids.length ? `AND a.id IN (${ids.map(() => '?').join(', ')})` : ''}
    ORDER BY a.offbudget, a.sort_order
  `,
    ids,
    true,
  );

  const errors: ReturnType<typeof handleSyncError>[] = [];
  const newTransactions: Array<TransactionEntity['id']> = [];
  const matchedTransactions: Array<TransactionEntity['id']> = [];
  const updatedAccounts: Array<AccountEntity['id']> = [];

  for (const acct of accounts) {
    if (acct.bankId && acct.account_id) {
      try {
        logger.group('Bank Sync operation for account:', acct.name);
        const syncResponse = await bankSync.syncAccount(
          userId as string,
          userKey as string,
          acct.id,
          acct.account_id,
          acct.bankId,
        );

        const syncResponseData = await handleSyncResponse(syncResponse, acct);

        newTransactions.push(...syncResponseData.newTransactions);
        matchedTransactions.push(...syncResponseData.matchedTransactions);
        updatedAccounts.push(...syncResponseData.updatedAccounts);
      } catch (err) {
        const error = err as Error;
        errors.push(handleSyncError(error, acct));
        captureException({
          ...error,
          message: 'Failed syncing account "' + acct.name + '."',
        } as Error);
      } finally {
        logger.groupEnd();
      }
    }
  }

  if (updatedAccounts.length > 0) {
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
    });
  }

  return { errors, newTransactions, matchedTransactions, updatedAccounts };
}

async function simpleFinBatchSync({
  ids = [],
}: {
  ids: Array<AccountEntity['id']>;
}): Promise<
  Array<{ accountId: AccountEntity['id']; res: SyncResponseWithErrors }>
> {
  const accounts = db.runQuery<db.DbAccount & { bankId: db.DbBank['bank_id'] }>(
    `SELECT a.*, b.bank_id as bankId FROM accounts a
         LEFT JOIN banks b ON a.bank = b.id
         WHERE
          a.tombstone = 0
          AND a.closed = 0
          AND a.account_sync_source = 'simpleFin'
          ${ids.length ? `AND a.id IN (${ids.map(() => '?').join(', ')})` : ''}
         ORDER BY a.offbudget, a.sort_order`,
    ids.length ? ids : [],
    true,
  );

  const retVal: Array<{
    accountId: AccountEntity['id'];
    res: {
      errors: ReturnType<typeof handleSyncError>[];
      newTransactions: Array<TransactionEntity['id']>;
      matchedTransactions: Array<TransactionEntity['id']>;
      updatedAccounts: Array<AccountEntity['id']>;
    };
  }> = [];

  logger.group('Bank Sync operation for all SimpleFin accounts');
  try {
    const syncResponses: Array<{
      accountId: AccountEntity['id'];
      res: {
        error_code: string;
        error_type: string;
        added: Array<TransactionEntity['id']>;
        updated: Array<TransactionEntity['id']>;
      };
    }> = await bankSync.simpleFinBatchSync(
      accounts.map(a => ({
        id: a.id,
        account_id: a.account_id || null,
      })),
    );
    for (const syncResponse of syncResponses) {
      const account = accounts.find(a => a.id === syncResponse.accountId);
      if (!account) {
        logger.error(
          `Invalid account ID found in response: ${syncResponse.accountId}. Proceeding to the next account...`,
        );
        continue;
      }

      const errors: ReturnType<typeof handleSyncError>[] = [];
      const newTransactions: Array<TransactionEntity['id']> = [];
      const matchedTransactions: Array<TransactionEntity['id']> = [];
      const updatedAccounts: Array<AccountEntity['id']> = [];

      if (syncResponse.res?.error_code) {
        errors.push(
          handleSyncError(
            {
              type: 'BankSyncError',
              reason: 'Failed syncing account "' + account.name + '."',
              category: syncResponse.res.error_type,
              code: syncResponse.res.error_code,
            } as BankSyncError,
            account,
          ),
        );
      } else if (syncResponse.res) {
        const syncResponseData = await handleSyncResponse(
          syncResponse.res,
          account,
        );

        newTransactions.push(...syncResponseData.newTransactions);
        matchedTransactions.push(...syncResponseData.matchedTransactions);
        updatedAccounts.push(...syncResponseData.updatedAccounts);
      } else {
        errors.push(
          handleSyncError(
            new Error(
              'Failed syncing account "' + account.name + '": empty response',
            ),
            account,
          ),
        );
      }

      retVal.push({
        accountId: syncResponse.accountId,
        res: { errors, newTransactions, matchedTransactions, updatedAccounts },
      });
    }
  } catch (err) {
    for (const account of accounts) {
      const error = err as Error;
      retVal.push({
        accountId: account.id,
        res: {
          errors: [handleSyncError(error, account)],
          newTransactions: [],
          matchedTransactions: [],
          updatedAccounts: [],
        },
      });
    }
  }

  if (retVal.some(a => a.res.updatedAccounts.length > 0)) {
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
    });
  }

  logger.groupEnd();

  return retVal;
}

export type ImportTransactionsResult = bankSync.ReconcileTransactionsResult & {
  errors: Array<{
    message: string;
  }>;
  statementReconciliation?: bankSync.StatementReconciliationResult;
};

async function importTransactions({
  accountId,
  transactions,
  isPreview,
  opts,
}: {
  accountId: AccountEntity['id'];
  transactions: ImportTransactionEntity[];
  isPreview: boolean;
  opts?: ImportTransactionsOpts;
}): Promise<ImportTransactionsResult> {
  if (typeof accountId !== 'string') {
    throw APIError('transactions-import: accountId must be an id');
  }

  try {
    const reconciled = await bankSync.reconcileTransactions(
      accountId,
      transactions,
      false,
      true,
      isPreview,
      opts?.defaultCleared,
      false,
      opts?.reimportDeleted,
    );
    const statementReconciliation =
      !isPreview && opts?.statementTargetBalance !== undefined
        ? await bankSync.reconcileStatement(
            accountId,
            transactions
              .map(transaction => transaction.imported_id)
              .filter((id): id is string => Boolean(id)),
            opts.statementTargetBalance,
          )
        : undefined;
    return {
      errors: [],
      added: reconciled.added,
      updated: reconciled.updated,
      updatedPreview: reconciled.updatedPreview,
      statementReconciliation,
    };
  } catch (err) {
    if (err instanceof TransactionError) {
      return {
        errors: [{ message: err.message }],
        added: [],
        updated: [],
        updatedPreview: [],
      };
    }

    throw err;
  }
}

async function unlinkAccount({ id }: { id: AccountEntity['id'] }) {
  const accRow = await db.first<db.DbAccount>(
    'SELECT * FROM accounts WHERE id = ?',
    [id],
  );

  if (!accRow) {
    throw new Error(`Account with ID ${id} not found.`);
  }

  const bankId = accRow.bank;

  if (!bankId) {
    return 'ok';
  }

  const isGoCardless = accRow.account_sync_source === 'goCardless';

  await db.updateAccount({
    id,
    account_id: null,
    bank: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
  });

  if (isGoCardless === false) {
    return;
  }

  const accountWithBankResult = await db.first<{ count: number }>(
    'SELECT COUNT(*) as count FROM accounts WHERE bank = ?',
    [bankId],
  );

  // No more accounts are associated with this bank. We can remove
  // it from GoCardless.
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return 'ok';
  }

  if (!accountWithBankResult || accountWithBankResult.count === 0) {
    const bank = await db.first<Pick<db.DbBank, 'bank_id'>>(
      'SELECT bank_id FROM banks WHERE id = ?',
      [bankId],
    );

    if (!bank) {
      throw new Error(`Bank with ID ${bankId} not found.`);
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('Failed to get server config.');
    }

    const requisitionId = bank.bank_id;

    try {
      await post(
        serverConfig.GOCARDLESS_SERVER + '/remove-account',
        {
          requisitionId,
        },
        {
          'X-ACTUAL-TOKEN': userToken,
        },
      );
    } catch (error) {
      logger.log({ error });
    }
  }

  return 'ok';
}

export const app = createApp<AccountHandlers>();

app.method('account-update', mutator(undoable(updateAccount)));
app.method('accounts-get', getAccounts);
app.method('account-balance', getAccountBalance);
app.method('account-properties', getAccountProperties);
app.method('accounts-revalue', mutator(revalueAccounts));
app.method('gocardless-accounts-link', linkGoCardlessAccount);
app.method('simplefin-accounts-link', linkSimpleFinAccount);
app.method('pluggyai-accounts-link', linkPluggyAiAccount);
app.method('account-create', mutator(undoable(createAccount)));
app.method('account-close', mutator(closeAccount));
app.method('account-reopen', mutator(undoable(reopenAccount)));
app.method('account-move', mutator(undoable(moveAccount)));
app.method('secret-set', setSecret);
app.method('secret-check', checkSecret);
app.method('gocardless-poll-web-token', pollGoCardlessWebToken);
app.method('gocardless-poll-web-token-stop', stopGoCardlessWebTokenPolling);
app.method('gocardless-status', goCardlessStatus);
app.method('simplefin-status', simpleFinStatus);
app.method('pluggyai-status', pluggyAiStatus);
app.method('simplefin-accounts', simpleFinAccounts);
app.method('pluggyai-accounts', pluggyAiAccounts);
app.method('gocardless-get-banks', getGoCardlessBanks);
app.method('gocardless-create-web-token', createGoCardlessWebToken);
app.method('accounts-bank-sync', accountsBankSync);
app.method('simplefin-batch-sync', simpleFinBatchSync);
app.method('transactions-import', mutator(undoable(importTransactions)));
app.method('account-unlink', mutator(unlinkAccount));

app.service(() => {
  const runRevaluation = () => {
    void sendMain('accounts-revalue', {}).catch(error => {
      logger.warn('Unable to run scheduled currency revaluation', { error });
    });
  };

  runRevaluation();
  const interval = setInterval(runRevaluation, 60 * 60 * 1000);
  return () => clearInterval(interval);
});
