import type { CurrencyMapping } from './currency.js';
import type { SourceTransaction } from './types.js';

export type StoredTransactionFields = {
  date: string;
  amount: number;
  original_amount?: number | null;
  original_currency?: string | null;
  exchange_rate?: string;
  exchange_rate_date?: string;
  payee_name: string;
  imported_payee: string;
  notes?: string;
  imported_id: string;
  cleared: boolean;
};

export function toTransactionFields(
  transaction: Pick<SourceTransaction, 'date' | 'description' | 'status'>,
  currency: CurrencyMapping,
  importedId: string,
): StoredTransactionFields {
  if (currency.amount == null) {
    throw new Error('Mapped transaction is missing an amount');
  }

  const fields: StoredTransactionFields = {
    date: transaction.date.slice(0, 10),
    amount: currency.amount,
    payee_name: transaction.description,
    imported_payee: transaction.description,
    imported_id: importedId,
    cleared: transaction.status === 'completed',
  };

  // Absent optional values must be omitted. An update writes every own
  // property, and SQLite rejects `undefined` query parameters.
  if (currency.original_amount !== undefined) {
    fields.original_amount = currency.original_amount;
  }
  if (currency.original_currency !== undefined) {
    fields.original_currency = currency.original_currency;
  }
  if (currency.exchange_rate !== undefined) {
    fields.exchange_rate = currency.exchange_rate;
  }
  if (currency.exchange_rate_date !== undefined) {
    fields.exchange_rate_date = currency.exchange_rate_date;
  }
  if (currency.notes !== undefined) {
    fields.notes = currency.notes;
  }

  return fields;
}

export function toTransactionUpdate(
  fields: StoredTransactionFields,
): Omit<StoredTransactionFields, 'payee_name'> {
  const { payee_name: _payeeName, ...updateFields } = fields;
  return updateFields;
}
