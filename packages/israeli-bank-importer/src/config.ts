import path from 'node:path';

import { CompanyTypes } from '@tomerh2001/israeli-bank-scrapers';

import { parseImportFromDate } from './import-from-date.js';
import type {
  HapoalimConfig,
  ImporterConfig,
  ImportTarget,
  VisaCalConfig,
} from './types.js';

const DEFAULT_STORAGE_DIR = '/data';

function requireString(
  value: unknown,
  field: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseTargets(value: unknown, field: string): ImportTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must contain at least one target`);
  }

  return value.map((target, index) => {
    if (!target || typeof target !== 'object') {
      throw new Error(`${field}[${index}] must be an object`);
    }

    const record = target as Record<string, unknown>;
    const sourceAccountNumbers = record.sourceAccountNumbers;
    if (
      sourceAccountNumbers !== 'all' &&
      (!Array.isArray(sourceAccountNumbers) ||
        sourceAccountNumbers.some(value => typeof value !== 'string'))
    ) {
      throw new Error(
        `${field}[${index}].sourceAccountNumbers must be "all" or a string array`,
      );
    }

    return {
      actualAccountId: requireString(
        record.actualAccountId,
        `${field}[${index}].actualAccountId`,
      ),
      sourceAccountNumbers,
    };
  });
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ImporterConfig {
  const configText = requireString(
    env.ISRAELI_BANK_IMPORTER_CONFIG,
    'ISRAELI_BANK_IMPORTER_CONFIG',
  );
  const parsed = JSON.parse(configText) as Record<string, unknown>;
  const actual = parsed.actual as Record<string, unknown> | undefined;
  const banks = parsed.banks;

  if (!actual || !Array.isArray(banks) || banks.length === 0) {
    throw new Error('Config must include actual and at least one bank');
  }

  const password =
    typeof actual.password === 'string' ? actual.password : undefined;
  const sessionToken =
    typeof actual.sessionToken === 'string' ? actual.sessionToken : undefined;
  if (!password && !sessionToken) {
    throw new Error('actual.password or actual.sessionToken is required');
  }

  const parsedBanks = banks.map<HapoalimConfig | VisaCalConfig>(
    (bank, index) => {
      if (!bank || typeof bank !== 'object') {
        throw new Error(`banks[${index}] must be an object`);
      }
      const record = bank as Record<string, unknown>;
      const credentials = record.credentials as
        | Record<string, unknown>
        | undefined;
      if (!credentials) {
        throw new Error(`banks[${index}].credentials is required`);
      }

      const targets = parseTargets(record.targets, `banks[${index}].targets`);
      if (record.companyId === CompanyTypes.hapoalim) {
        return {
          companyId: CompanyTypes.hapoalim,
          credentials: {
            userCode: requireString(
              credentials.userCode,
              `banks[${index}].credentials.userCode`,
            ),
            password: requireString(
              credentials.password,
              `banks[${index}].credentials.password`,
            ),
          },
          targets,
        } satisfies HapoalimConfig;
      }
      if (record.companyId === CompanyTypes.visaCal) {
        return {
          companyId: CompanyTypes.visaCal,
          credentials: {
            username: requireString(
              credentials.username,
              `banks[${index}].credentials.username`,
            ),
            password: requireString(
              credentials.password,
              `banks[${index}].credentials.password`,
            ),
          },
          targets,
        } satisfies VisaCalConfig;
      }
      throw new Error(
        `banks[${index}].companyId must be "hapoalim" or "visaCal"`,
      );
    },
  );

  const storageDir =
    typeof parsed.storageDir === 'string'
      ? parsed.storageDir
      : env.IMPORTER_STORAGE_DIR || DEFAULT_STORAGE_DIR;
  const pendingGraceDays =
    typeof parsed.pendingGraceDays === 'number' ? parsed.pendingGraceDays : 7;

  if (!Number.isInteger(pendingGraceDays) || pendingGraceDays < 1) {
    throw new Error('pendingGraceDays must be a positive integer');
  }

  return {
    actual: {
      serverURL: requireString(actual.serverURL, 'actual.serverURL'),
      password,
      sessionToken,
      syncId: requireString(actual.syncId, 'actual.syncId'),
      budgetPassword:
        typeof actual.budgetPassword === 'string'
          ? actual.budgetPassword
          : undefined,
    },
    banks: parsedBanks,
    schedule:
      typeof parsed.schedule === 'string' ? parsed.schedule : env.SCHEDULE,
    timezone:
      typeof parsed.timezone === 'string'
        ? parsed.timezone
        : env.TZ || 'Asia/Jerusalem',
    storageDir: path.resolve(storageDir),
    pendingGraceDays,
    importFromDate: parseImportFromDate(parsed.importFromDate),
    dryRun: parsed.dryRun === true || env.DRY_RUN === 'true',
  };
}
