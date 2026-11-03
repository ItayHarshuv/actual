export type AccountEntity = {
  id: string;
  name: string;
  offbudget: 0 | 1;
  closed: 0 | 1;
  sort_order: number;
  last_reconciled: string | null;
  tombstone: 0 | 1;
  conversion_fee_percent?: number;
  exchange_rate_provider?: 'frankfurter' | 'bank-of-israel';
  currency?: string | null;
  revaluation_category?: string | null;
  last_revaluation_check?: string | null;
  currency_revaluation_amount?: number;
  currency_revaluation_rate?: string | null;
  currency_revaluation_date?: string | null;
  currency_native_balance?: number;

  // Sync fields
  account_id: string | null;
  bank: string | null;
  bankName: string | null;
  bankId: string | null;
  mask: string | null; // end of bank account number
  official_name: string | null;
  balance_current: number | null;
  balance_available: number | null;
  balance_limit: number | null;
  account_sync_source: AccountSyncSource | null;
  last_sync: string | null;
};

export type AccountSyncSource = 'simpleFin' | 'goCardless' | 'pluggyai';
