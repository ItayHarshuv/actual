// @ts-strict-ignore
import { parse as csv2json } from 'csv-parse/sync';

import * as fs from '../../../platform/server/fs';
import { logger } from '../../../platform/server/log';
import { looselyParseAmount } from '../../../shared/util';

import { ofx2json } from './ofx2json';
import { qif2json } from './qif2json';
import { xmlCAMT2json } from './xmlcamt2json';

/**
 * Parse OFX amount strings to numbers.
 * Handles various OFX amount formats including currency symbols, parentheses, and multiple decimal places.
 * Returns null for invalid amounts instead of NaN.
 */
function parseOfxAmount(amount: string): number | null {
  if (!amount || typeof amount !== 'string') {
    return null;
  }

  // Handle parentheses for negative amounts (e.g., "(30.00)" -> "-30.00")
  let cleaned = amount.trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }

  // Remove currency symbols and other non-numeric characters except decimal point and minus sign
  cleaned = cleaned.replace(/[^\d.-]/g, '');

  // Handle multiple decimal points by keeping only the first one
  const decimalIndex = cleaned.indexOf('.');
  if (decimalIndex !== -1) {
    const beforeDecimal = cleaned.slice(0, decimalIndex);
    const afterDecimal = cleaned.slice(decimalIndex + 1).replace(/\./g, '');
    cleaned = beforeDecimal + '.' + afterDecimal;
  }

  // Ensure we have a valid number format
  if (!cleaned || cleaned === '-' || cleaned === '.') {
    return null;
  }

  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

type StructuredTransaction = {
  amount: number;
  date: string;
  payee_name: string;
  imported_payee: string;
  notes: string;
  imported_id?: string;
  original_amount?: number;
  original_currency?: string;
};

// CSV files return raw data that are not guaranteed to be StructuredTransactions
type CsvTransaction = Record<string, string> | string[];

type Transaction = StructuredTransaction | CsvTransaction;

type ParseError = { message: string; internal: string };
export type ParsedStatement = {
  type: 'hapoalim-visa';
  accountLastFour: string;
  paymentDate: string;
  targetBalance: number;
  currency: 'ILS';
};

export type ParseFileResult = {
  errors: ParseError[];
  transactions?: Transaction[];
  statement?: ParsedStatement;
};

export type ParseFileOptions = {
  hasHeaderRow?: boolean;
  delimiter?: string;
  fallbackMissingPayeeToMemo?: boolean;
  swapPayeeAndMemo?: boolean;
  skipStartLines?: number;
  skipEndLines?: number;
  importNotes?: boolean;
};

export async function parseFile(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const m = filepath.match(/\.[^.]*$/);

  if (m) {
    const ext = m[0];

    switch (ext.toLowerCase()) {
      case '.qif':
        return parseQIF(filepath, options);
      case '.csv':
      case '.tsv':
        return parseCSV(filepath, options);
      case '.ofx':
      case '.qfx':
        return parseOFX(filepath, options);
      case '.xml':
        return parseCAMT(filepath, options);
      default:
    }
  }

  errors.push({
    message: 'Invalid file type',
    internal: '',
  });
  return { errors, transactions: [] };
}

async function parseCSV(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  let contents = await fs.readFile(filepath);

  const statementDelimiters = new Set([
    options.delimiter || ',',
    ',',
    ';',
    '\t',
  ]);
  for (const delimiter of statementDelimiters) {
    const statement = parseHapoalimVisaCSV(contents, delimiter);
    if (statement) {
      return statement;
    }
  }

  const skipStart = Math.max(0, options.skipStartLines || 0);
  const skipEnd = Math.max(0, options.skipEndLines || 0);

  if (skipStart > 0 || skipEnd > 0) {
    const lines = contents.split(/\r?\n/);

    if (skipStart + skipEnd >= lines.length) {
      errors.push({
        message: 'Cannot skip more lines than exist in the file',
        internal: `Attempted to skip ${skipStart} start + ${skipEnd} end lines from ${lines.length} total lines`,
      });
      return { errors, transactions: [] };
    }

    const startLine = skipStart;
    const endLine = skipEnd > 0 ? lines.length - skipEnd : lines.length;
    contents = lines.slice(startLine, endLine).join('\r\n');
  }

  let data: ReturnType<typeof csv2json>;
  try {
    data = csv2json(contents, {
      columns: options?.hasHeaderRow,
      bom: true,
      delimiter: options?.delimiter || ',',

      quote: '"',
      trim: true,
      relax_column_count: true,
      skip_empty_lines: true,
    });
  } catch (err) {
    errors.push({
      message: 'Failed parsing: ' + err.message,
      internal: err.message,
    });
    return { errors, transactions: [] };
  }

  return { errors, transactions: data };
}

function parseHapoalimVisaCSV(
  contents: string,
  delimiter: string,
): ParseFileResult | null {
  let rows: string[][];
  try {
    rows = csv2json(contents, {
      bom: true,
      delimiter,
      quote: '"',
      trim: true,
      relax_column_count: true,
      skip_empty_lines: false,
    });
  } catch {
    return null;
  }

  const title = rows[0]?.[0] || '';
  const titleMatch = title.match(/פירוט עסקאות.*כרטיס ויזה.*מסתיים ב-?(\d{4})/);
  if (!titleMatch) {
    return null;
  }

  const summary = rows.find(row => row[0]?.includes('עסקאות לחיוב'))?.[0];
  const summaryMatch = summary?.match(
    /עסקאות לחיוב ב-(\d{1,2}\/\d{1,2}\/\d{4}):\s*([₪\d,.\s-]+)/,
  );
  const headerIndex = rows.findIndex(
    row =>
      row[0]?.includes('תאריך') &&
      row[1]?.includes('שם בית עסק') &&
      row[3]?.includes('סכום') &&
      row[3]?.includes('חיוב'),
  );
  if (!summaryMatch || headerIndex === -1) {
    return null;
  }

  const paymentDate = parseIsraeliDate(summaryMatch[1]);
  const statementTotal = looselyParseAmount(summaryMatch[2]);
  if (!paymentDate || statementTotal == null) {
    return null;
  }

  const transactions: StructuredTransaction[] = [];
  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    const date = parseIsraeliDate(row[0]);
    const payee = row[1]?.trim();
    const chargedAmount = looselyParseAmount(row[3] || '');
    if (!date || !payee || chargedAmount == null) {
      continue;
    }

    const originalAmount = looselyParseAmount(row[2] || '');
    const originalCurrency = getStatementCurrency(row[2]);
    const notes = [row[4], row[5], row[6]].filter(Boolean).join(' · ');

    transactions.push({
      amount: -Math.abs(chargedAmount),
      date,
      payee_name: payee,
      imported_payee: payee,
      notes,
      imported_id: `hapoalim-visa-${titleMatch[1]}-${paymentDate}-${index - headerIndex}`,
      ...(originalAmount != null &&
        originalCurrency &&
        originalCurrency !== 'ILS' && {
          original_amount: -Math.abs(originalAmount),
          original_currency: originalCurrency,
        }),
    });
  }

  if (transactions.length === 0) {
    return null;
  }

  const importedTotal = transactions.reduce(
    (total, transaction) => total - transaction.amount,
    0,
  );
  if (
    Math.round(importedTotal * 100) !==
    Math.round(Math.abs(statementTotal) * 100)
  ) {
    return {
      errors: [
        {
          message: 'Statement total does not match its transactions',
          internal: `Expected ${statementTotal}, parsed ${importedTotal}`,
        },
      ],
      transactions: [],
    };
  }

  return {
    errors: [],
    transactions,
    statement: {
      type: 'hapoalim-visa',
      accountLastFour: titleMatch[1],
      paymentDate,
      targetBalance: -Math.abs(statementTotal),
      currency: 'ILS',
    },
  };
}

function parseIsraeliDate(value: string | undefined): string | null {
  const match = value?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, day, month, year] = match;
  const parsed = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function getStatementCurrency(value: string | undefined): string | null {
  if (value?.includes('$')) {
    return 'USD';
  }
  if (value?.includes('₪')) {
    return 'ILS';
  }
  return null;
}

async function parseQIF(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: ReturnType<typeof qif2json>;
  try {
    data = qif2json(contents);
  } catch (err) {
    errors.push({
      message: "Failed parsing: doesn't look like a valid QIF file.",
      internal: err.stack,
    });
    return { errors, transactions: [] };
  }

  const swap = options.swapPayeeAndMemo;

  return {
    errors: [],
    transactions: data.transactions
      .map(trans => {
        const payeeSource = swap ? trans.memo : trans.payee;
        const memoSource = swap ? trans.payee : trans.memo;
        const fallbackUsed = !payeeSource && swap;

        return {
          amount:
            trans.amount != null ? looselyParseAmount(trans.amount) : null,
          date: trans.date,
          payee_name: payeeSource || (fallbackUsed ? memoSource : null),
          imported_payee: payeeSource || (fallbackUsed ? memoSource : null),
          notes:
            options.importNotes && !fallbackUsed ? memoSource || null : null,
        };
      })
      .filter(trans => trans.date != null && trans.amount != null),
  };
}

async function parseOFX(
  filepath: string,
  options: ParseFileOptions,
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof ofx2json>>;
  try {
    data = await ofx2json(contents);
  } catch (err) {
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  // Banks don't always implement the OFX standard properly
  // If no payee is available try and fallback to memo
  const useMemoFallback = options.fallbackMissingPayeeToMemo;
  const swap = options.swapPayeeAndMemo;

  return {
    errors,
    transactions: data.transactions.map(trans => {
      const parsedAmount = parseOfxAmount(trans.amount);
      if (parsedAmount === null) {
        errors.push({
          message: `Invalid amount format: ${trans.amount}`,
          internal: `Failed to parse amount: ${trans.amount}`,
        });
      }

      const payeeSource = swap ? trans.memo : trans.name;
      const memoSource = swap ? trans.name : trans.memo;
      const fallbackUsed = !payeeSource && useMemoFallback;

      return {
        amount: parsedAmount || 0,
        imported_id: trans.fitId,
        date: trans.date,
        payee_name: payeeSource || (fallbackUsed ? memoSource : null),
        imported_payee: payeeSource || (fallbackUsed ? memoSource : null),
        notes: options.importNotes && !fallbackUsed ? memoSource || null : null,
      };
    }),
  };
}

async function parseCAMT(
  filepath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = Array<ParseError>();
  const contents = await fs.readFile(filepath);

  let data: Awaited<ReturnType<typeof xmlCAMT2json>>;
  try {
    data = await xmlCAMT2json(contents);
  } catch (err) {
    logger.error(err);
    errors.push({
      message: 'Failed importing file',
      internal: err.stack,
    });
    return { errors };
  }

  const swap = options.swapPayeeAndMemo;

  return {
    errors,
    transactions: data.map(trans => {
      const payeeSource = swap ? trans.notes : trans.payee_name;
      const memoSource = swap ? trans.payee_name : trans.notes;
      const fallbackUsed = !payeeSource && swap;

      return {
        ...trans,
        payee_name: payeeSource || (fallbackUsed ? memoSource : null),
        imported_payee: payeeSource || (fallbackUsed ? memoSource : null),
        notes: options.importNotes && !fallbackUsed ? memoSource || null : null,
      };
    }),
  };
}
