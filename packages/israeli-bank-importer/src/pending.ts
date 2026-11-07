import { createHash } from 'node:crypto';

import { CompanyTypes } from '@tomerh2001/israeli-bank-scrapers';

import type { PendingRecord, SourceTransactionWithContext } from './types.js';

function normalizeDescription(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('he-IL')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function dateDistanceInDays(left: string, right: string): number {
  return Math.abs(
    (new Date(left).getTime() - new Date(right).getTime()) / 86_400_000,
  );
}

export function sourceIdentifier(
  context: SourceTransactionWithContext,
): string | undefined {
  const identifier = context.transaction.identifier;
  return identifier == null ? undefined : String(identifier);
}

export function pendingFingerprint(
  context: SourceTransactionWithContext,
  occurrence = 0,
): string {
  const transaction = context.transaction;
  const rawMerchantId = transaction.rawTransaction?.merchantID;
  const identity = {
    companyId: context.companyId,
    sourceAccountNumber: context.sourceAccountNumber,
    identifier: sourceIdentifier(context),
    merchantId: typeof rawMerchantId === 'string' ? rawMerchantId : undefined,
    date: transaction.date.slice(0, 10),
    originalAmount: transaction.originalAmount,
    originalCurrency: transaction.originalCurrency,
    description: normalizeDescription(transaction.description),
    occurrence,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 24);
  return `pending:${context.companyId}:${context.sourceAccountNumber}:${digest}`;
}

export function completedImportedId(
  context: SourceTransactionWithContext,
): string {
  const transaction = context.transaction;
  const identity =
    sourceIdentifier(context) ??
    [
      transaction.date.slice(0, 10),
      transaction.originalAmount,
      transaction.originalCurrency,
      normalizeDescription(transaction.description),
    ].join(':');
  return `israeli-importer:${context.companyId}:${context.sourceAccountNumber}:${identity}`;
}

export function findPendingMatch(
  completed: SourceTransactionWithContext,
  records: PendingRecord[],
  excludedFingerprints: Set<string> = new Set(),
): PendingRecord | undefined {
  const identifier = sourceIdentifier(completed);
  const eligible = records.filter(
    record =>
      !excludedFingerprints.has(record.fingerprint) &&
      record.companyId === completed.companyId &&
      record.sourceAccountNumber === completed.sourceAccountNumber &&
      record.actualAccountId === completed.actualAccountId,
  );

  if (identifier) {
    const direct = eligible.find(
      record => record.sourceIdentifier === identifier,
    );
    if (direct) {
      return direct;
    }
  }

  const transaction = completed.transaction;
  const normalizedDescription = normalizeDescription(transaction.description);
  const candidates = eligible
    .filter(record => {
      const sameCurrency =
        record.originalCurrency === transaction.originalCurrency;
      const sameAmount =
        Math.abs(record.originalAmount - transaction.originalAmount) < 0.01;
      const sameDescription =
        normalizeDescription(record.description) === normalizedDescription;
      const allowedDateDistance =
        completed.companyId === CompanyTypes.visaCal ? 7 : 3;
      return (
        sameCurrency &&
        sameAmount &&
        sameDescription &&
        dateDistanceInDays(record.transactionDate, transaction.date) <=
          allowedDateDistance
      );
    })
    .sort(
      (left, right) =>
        dateDistanceInDays(left.transactionDate, transaction.date) -
        dateDistanceInDays(right.transactionDate, transaction.date),
    );

  return candidates[0];
}

export function isPastGracePeriod(
  record: PendingRecord,
  now: Date,
  graceDays: number,
): boolean {
  return (
    now.getTime() - new Date(record.lastSeenAt).getTime() >=
    graceDays * 86_400_000
  );
}
