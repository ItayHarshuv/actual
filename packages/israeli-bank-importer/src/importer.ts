import path from 'node:path';

import * as actual from '@actual-app/api';
import { CompanyTypes, createScraper } from '@tomerh2001/israeli-bank-scrapers';
import type { ScraperCredentials } from '@tomerh2001/israeli-bank-scrapers';

import type {
  AccountEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { mapCurrency } from './currency.js';
import {
  toScrapeStartDate,
  transactionsOnOrAfter,
} from './import-from-date.js';
import {
  completedImportedId,
  findPendingMatch,
  isPastGracePeriod,
  pendingFingerprint,
  sourceIdentifier,
} from './pending.js';
import { PendingStateStore, prepareStorage } from './state.js';
import { selectTransactionsForImport } from './transaction-limit.js';
import type {
  ImporterConfig,
  ImportTarget,
  PendingRecord,
  SourceTransaction,
  SourceTransactionWithContext,
} from './types.js';
import { toUpdateFields } from './update-fields.js';

type SourceAccount = {
  accountNumber: string;
  txns: SourceTransaction[];
};

type OtpCodeRetriever = () => Promise<string>;

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }),
  );
}

function selectTarget(
  sourceAccountNumber: string,
  targets: ImportTarget[],
): ImportTarget | undefined {
  const matches = targets.filter(
    target =>
      target.sourceAccountNumbers === 'all' ||
      target.sourceAccountNumbers.includes(sourceAccountNumber),
  );
  if (matches.length > 1) {
    throw new Error(
      `Source account ${sourceAccountNumber} maps to multiple Actual accounts`,
    );
  }
  return matches[0];
}

function toDate(value: string): string {
  return value.slice(0, 10);
}

async function findActualTransaction(
  record: PendingRecord,
): Promise<TransactionEntity | undefined> {
  const transactions = await actual.getTransactions(
    record.actualAccountId,
    record.transactionDate,
    record.transactionDate,
  );
  return transactions.find(
    (transaction: TransactionEntity) =>
      transaction.id === record.actualTransactionId ||
      transaction.imported_id === record.fingerprint,
  );
}

async function buildFields(
  context: SourceTransactionWithContext,
  exchangeRateProvider: 'frankfurter' | 'bank-of-israel',
  importedId: string,
) {
  const currency = await mapCurrency(context.transaction, exchangeRateProvider);
  return {
    date: toDate(context.transaction.date),
    amount: currency.amount,
    original_amount: currency.original_amount,
    original_currency: currency.original_currency,
    exchange_rate: currency.exchange_rate,
    exchange_rate_date: currency.exchange_rate_date,
    payee_name: context.transaction.description,
    imported_payee: context.transaction.description,
    notes: currency.notes,
    imported_id: importedId,
    cleared: context.transaction.status === 'completed',
  };
}

async function recoverImportedTransactionId(
  context: SourceTransactionWithContext,
  importedId: string,
): Promise<string | undefined> {
  const date = toDate(context.transaction.date);
  const transactions = await actual.getTransactions(
    context.actualAccountId,
    date,
    date,
  );
  return transactions.find(
    (transaction: TransactionEntity) => transaction.imported_id === importedId,
  )?.id;
}

async function importPending(
  context: SourceTransactionWithContext,
  fingerprint: string,
  existing: PendingRecord | undefined,
  exchangeRateProvider: 'frankfurter' | 'bank-of-israel',
  config: ImporterConfig,
): Promise<PendingRecord | undefined> {
  const fields = await buildFields(context, exchangeRateProvider, fingerprint);
  const now = new Date().toISOString();

  if (config.dryRun) {
    log('pending_dry_run', {
      companyId: context.companyId,
      sourceAccountNumber: context.sourceAccountNumber,
      actualAccountId: context.actualAccountId,
      importedId: fingerprint,
    });
    return existing;
  }

  let actualTransactionId = existing?.actualTransactionId;
  if (existing) {
    const transaction = await findActualTransaction(existing);
    if (transaction?.cleared || transaction?.reconciled) {
      log('pending_user_managed', { transactionId: transaction.id });
      return { ...existing, lastSeenAt: now };
    }
    if (transaction) {
      await actual.updateTransaction(transaction.id, toUpdateFields(fields));
      actualTransactionId = transaction.id;
    }
  }

  if (!actualTransactionId) {
    const result = await actual.importTransactions(
      context.actualAccountId,
      [fields],
      { defaultCleared: false, dryRun: false },
    );
    actualTransactionId =
      result.added[0] ??
      result.updated[0] ??
      (await recoverImportedTransactionId(context, fingerprint));
  }

  if (!actualTransactionId) {
    throw new Error(
      `Could not locate imported pending transaction ${fingerprint}`,
    );
  }

  return {
    fingerprint,
    actualTransactionId,
    actualAccountId: context.actualAccountId,
    companyId: context.companyId,
    sourceAccountNumber: context.sourceAccountNumber,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    transactionDate: toDate(context.transaction.date),
    description: context.transaction.description,
    originalAmount: context.transaction.originalAmount,
    originalCurrency: context.transaction.originalCurrency,
    sourceIdentifier: sourceIdentifier(context),
  };
}

async function importCompleted(
  context: SourceTransactionWithContext,
  pendingRecords: PendingRecord[],
  matchedPending: Set<string>,
  exchangeRateProvider: 'frankfurter' | 'bank-of-israel',
  config: ImporterConfig,
): Promise<string | undefined> {
  const importedId = completedImportedId(context);
  const fields = await buildFields(context, exchangeRateProvider, importedId);
  const pendingMatch = findPendingMatch(
    context,
    pendingRecords,
    matchedPending,
  );

  if (config.dryRun) {
    log('completed_dry_run', {
      importedId,
      pendingMatch: pendingMatch?.fingerprint,
    });
    return undefined;
  }

  if (pendingMatch) {
    const existing = await findActualTransaction(pendingMatch);
    if (existing && !existing.cleared && !existing.reconciled) {
      await actual.updateTransaction(existing.id, toUpdateFields(fields));
      matchedPending.add(pendingMatch.fingerprint);
      log('pending_settled', {
        transactionId: existing.id,
        companyId: context.companyId,
      });
      return pendingMatch.fingerprint;
    }
  }

  const result = await actual.importTransactions(
    context.actualAccountId,
    [fields],
    { defaultCleared: true, dryRun: false },
  );
  log('completed_imported', {
    companyId: context.companyId,
    sourceAccountNumber: context.sourceAccountNumber,
    added: result.added.length,
    updated: result.updated.length,
  });
  return undefined;
}

async function cleanUpStalePending(
  records: Record<string, PendingRecord>,
  seenPending: Set<string>,
  successfulBanks: Set<PendingRecord['companyId']>,
  config: ImporterConfig,
): Promise<void> {
  const now = new Date();
  for (const [fingerprint, record] of Object.entries(records)) {
    if (
      !successfulBanks.has(record.companyId) ||
      seenPending.has(fingerprint) ||
      !isPastGracePeriod(record, now, config.pendingGraceDays)
    ) {
      continue;
    }

    const transaction = await findActualTransaction(record);
    if (!transaction || transaction.cleared || transaction.reconciled) {
      delete records[fingerprint];
      continue;
    }

    if (!config.dryRun) {
      await actual.deleteTransaction(transaction.id);
      delete records[fingerprint];
    }
    log('pending_expired', {
      transactionId: transaction.id,
      fingerprint,
      dryRun: config.dryRun,
    });
  }
}

async function scrapeBank(
  config: ImporterConfig,
  bank: ImporterConfig['banks'][number],
  records: Record<string, PendingRecord>,
  seenPending: Set<string>,
  retrieveOtpCode: OtpCodeRetriever,
): Promise<void> {
  const startDate = toScrapeStartDate(config.importFromDate);
  log('scrape_started', {
    companyId: bank.companyId,
    startDate: startDate.toISOString(),
    importFromDate: config.importFromDate ?? null,
  });
  const scraper = createScraper({
    companyId: bank.companyId,
    startDate,
    timeout: 15 * 60_000,
    additionalTransactionInformation: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--user-data-dir=${path.join(config.storageDir, 'chrome-data')}`,
    ],
  });
  scraper.onProgress((_companyId, payload) => {
    log('scraper_progress', {
      companyId: bank.companyId,
      status: payload.type,
    });
  });

  const credentials =
    bank.companyId === CompanyTypes.hapoalim
      ? { ...bank.credentials, otpCodeRetriever: retrieveOtpCode }
      : bank.credentials;
  const result = await scraper.scrape(credentials as ScraperCredentials);
  if (!result.success) {
    throw new Error(
      `${bank.companyId} scrape failed (${result.errorType}): ${result.errorMessage}`,
    );
  }

  const accounts = (result.accounts ?? []) as SourceAccount[];
  const actualAccounts = await actual.getAccounts();
  const pendingRecords = Object.values(records);
  const matchedPending = new Set<string>();

  for (const sourceAccount of accounts) {
    const sourceAccountNumber = String(sourceAccount.accountNumber);
    const target = selectTarget(sourceAccountNumber, bank.targets);
    if (!target) {
      log('source_account_unmapped', {
        companyId: bank.companyId,
        sourceAccountNumber,
      });
      continue;
    }
    const actualAccount = actualAccounts.find(
      (account: AccountEntity) => account.id === target.actualAccountId,
    );
    if (!actualAccount) {
      throw new Error(
        `Actual account ${target.actualAccountId} does not exist`,
      );
    }
    const exchangeRateProvider =
      actualAccount.exchange_rate_provider ?? 'bank-of-israel';
    const sourceTransactions = sourceAccount.txns as SourceTransaction[];
    const datedTransactions = transactionsOnOrAfter(
      sourceTransactions,
      config.importFromDate,
    );
    if (
      config.importFromDate &&
      datedTransactions.length !== sourceTransactions.length
    ) {
      log('transactions_before_import_from_date', {
        companyId: bank.companyId,
        sourceAccountNumber,
        importFromDate: config.importFromDate,
        skipped: sourceTransactions.length - datedTransactions.length,
      });
    }
    const transactions = selectTransactionsForImport(
      bank.companyId,
      datedTransactions,
    );
    const contexts = transactions.map(transaction => ({
      companyId: bank.companyId,
      sourceAccountNumber,
      actualAccountId: target.actualAccountId,
      transaction,
    }));

    for (const context of contexts.filter(
      context => context.transaction.status === 'completed',
    )) {
      const settledFingerprint = await importCompleted(
        context,
        pendingRecords,
        matchedPending,
        exchangeRateProvider,
        config,
      );
      if (settledFingerprint) {
        delete records[settledFingerprint];
      }
    }

    const occurrenceCounts = new Map<string, number>();
    for (const context of contexts.filter(
      context => context.transaction.status === 'pending',
    )) {
      const baseFingerprint = pendingFingerprint(context);
      const occurrence = occurrenceCounts.get(baseFingerprint) ?? 0;
      occurrenceCounts.set(baseFingerprint, occurrence + 1);
      const fingerprint = pendingFingerprint(context, occurrence);
      const record = await importPending(
        context,
        fingerprint,
        records[fingerprint],
        exchangeRateProvider,
        config,
      );
      seenPending.add(fingerprint);
      if (record) {
        records[fingerprint] = record;
      } else {
        delete records[fingerprint];
      }
    }
  }
}

export async function runImport(
  config: ImporterConfig,
  retrieveOtpCode: OtpCodeRetriever,
): Promise<void> {
  const { actualDataDir } = await prepareStorage(config.storageDir);
  const stateStore = new PendingStateStore(config.storageDir);
  const state = await stateStore.load();
  const seenPending = new Set<string>();
  const successfulBanks = new Set<PendingRecord['companyId']>();

  await actual.init({
    dataDir: actualDataDir,
    serverURL: config.actual.serverURL,
    password: config.actual.password,
    sessionToken: config.actual.sessionToken,
  });

  try {
    await actual.downloadBudget(config.actual.syncId, {
      password: config.actual.budgetPassword,
    });
    const failures: Error[] = [];
    for (const bank of config.banks) {
      try {
        await scrapeBank(
          config,
          bank,
          state.records,
          seenPending,
          retrieveOtpCode,
        );
        successfulBanks.add(bank.companyId);
        await stateStore.save(state);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        log('bank_import_failed', {
          companyId: bank.companyId,
          error: failure.message,
        });
      }
    }
    await cleanUpStalePending(
      state.records,
      seenPending,
      successfulBanks,
      config,
    );
    await stateStore.save(state);
    if (!config.dryRun) {
      await actual.sync();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more bank imports failed');
    }
  } finally {
    await actual.shutdown();
  }
}
