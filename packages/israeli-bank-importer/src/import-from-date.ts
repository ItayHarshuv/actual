import type { SourceTransaction } from './types.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_HISTORY_MS = 2 * 365 * 86_400_000;

export function parseImportFromDate(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error('importFromDate must be a YYYY-MM-DD date');
  }

  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('importFromDate must be a real calendar date');
  }

  return value;
}

export function toScrapeStartDate(
  importFromDate: string | undefined,
  now = Date.now(),
): Date {
  if (!importFromDate) {
    return new Date(now - DEFAULT_HISTORY_MS);
  }

  const [year, month, day] = importFromDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function transactionsOnOrAfter(
  transactions: SourceTransaction[],
  importFromDate: string | undefined,
): SourceTransaction[] {
  if (!importFromDate) {
    return transactions;
  }

  return transactions.filter(
    transaction => transaction.date.slice(0, 10) >= importFromDate,
  );
}
