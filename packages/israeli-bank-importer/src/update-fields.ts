import type { TransactionEntity } from '@actual-app/core/types/models';

export type ImportedTransactionFields = {
  date: string;
  amount?: number;
  original_amount?: number | null;
  original_currency?: string | null;
  exchange_rate?: string;
  exchange_rate_date?: string;
  payee_name?: string;
  imported_payee?: string;
  notes?: string;
  imported_id: string;
  cleared: boolean;
};

// Actual rejects undefined query values. Omit them so an update only
// changes fields the bank actually provided.
export function toUpdateFields(
  fields: ImportedTransactionFields,
): Partial<TransactionEntity> {
  const {
    payee_name: _payeeName,
    amount,
    original_amount,
    original_currency,
    exchange_rate,
    exchange_rate_date,
    imported_payee,
    notes,
    ...required
  } = fields;

  return {
    ...required,
    ...(amount !== undefined ? { amount } : {}),
    ...(original_amount !== undefined ? { original_amount } : {}),
    ...(original_currency !== undefined ? { original_currency } : {}),
    ...(exchange_rate !== undefined ? { exchange_rate } : {}),
    ...(exchange_rate_date !== undefined ? { exchange_rate_date } : {}),
    ...(imported_payee !== undefined ? { imported_payee } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}
