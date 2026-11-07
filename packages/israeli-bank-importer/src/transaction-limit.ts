import { CompanyTypes } from '@tomerh2001/israeli-bank-scrapers';

import type { SourceTransaction } from './types.js';

const HAPOALIM_TRANSACTION_LIMIT = 10;

export function selectTransactionsForImport(
  companyId: CompanyTypes,
  transactions: SourceTransaction[],
): SourceTransaction[] {
  if (companyId !== CompanyTypes.hapoalim) {
    return transactions;
  }

  return [...transactions]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, HAPOALIM_TRANSACTION_LIMIT);
}
