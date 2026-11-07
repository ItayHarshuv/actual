import type { CompanyTypes } from '@tomerh2001/israeli-bank-scrapers';

export type ImportTarget = {
  actualAccountId: string;
  sourceAccountNumbers: string[] | 'all';
};

type BankConfig = {
  targets: ImportTarget[];
};

export type HapoalimConfig = BankConfig & {
  companyId: CompanyTypes.hapoalim;
  credentials: {
    userCode: string;
    password: string;
  };
};

export type VisaCalConfig = BankConfig & {
  companyId: CompanyTypes.visaCal;
  credentials: {
    username: string;
    password: string;
  };
};

export type ImporterConfig = {
  actual: {
    serverURL: string;
    password?: string;
    sessionToken?: string;
    syncId: string;
    budgetPassword?: string;
  };
  banks: Array<HapoalimConfig | VisaCalConfig>;
  schedule?: string;
  timezone: string;
  storageDir: string;
  pendingGraceDays: number;
  dryRun: boolean;
};

export type SourceTransaction = {
  type: string;
  identifier?: string | number;
  date: string;
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status: 'pending' | 'completed';
  rawTransaction?: Record<string, unknown>;
};

export type SourceTransactionWithContext = {
  companyId: CompanyTypes.hapoalim | CompanyTypes.visaCal;
  sourceAccountNumber: string;
  actualAccountId: string;
  transaction: SourceTransaction;
};

export type PendingRecord = {
  fingerprint: string;
  actualTransactionId: string;
  actualAccountId: string;
  companyId: CompanyTypes.hapoalim | CompanyTypes.visaCal;
  sourceAccountNumber: string;
  firstSeenAt: string;
  lastSeenAt: string;
  transactionDate: string;
  description: string;
  originalAmount: number;
  originalCurrency: string;
  sourceIdentifier?: string;
};

export type PendingState = {
  version: 1;
  records: Record<string, PendingRecord>;
};
