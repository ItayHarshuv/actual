import * as asyncStorage from '../../platform/server/asyncStorage';
import { fetch } from '../../platform/server/fetch';
import * as fs from '../../platform/server/fs';
import { exchangeRateCurrencies } from '../../shared/currencies';
import { currentDay } from '../../shared/months';
import { stringToInteger } from '../../shared/util';
import type {
  GlobalPrefs,
  MetadataPrefs,
  SyncedPrefs,
} from '../../types/prefs';
import { createApp } from '../app';
import * as db from '../db';
import { PostError } from '../errors';
import { getDefaultDocumentDir } from '../main';
import { mutator } from '../mutators';
import { post } from '../post';
import {
  getPrefs as _getMetadataPrefs,
  savePrefs as _saveMetadataPrefs,
} from '../prefs';
import { getServer } from '../server-config';
import { undoable } from '../undo';

export type PreferencesHandlers = {
  'preferences/save': typeof saveSyncedPrefs;
  'preferences/get': typeof getSyncedPrefs;
  'exchange-rates/get': typeof getExchangeRate;
  'save-global-prefs': typeof saveGlobalPrefs;
  'load-global-prefs': typeof loadGlobalPrefs;
  'save-prefs': typeof saveMetadataPrefs;
  'load-prefs': typeof loadMetadataPrefs;
  'save-server-prefs': typeof saveServerPrefs;
};

export const app = createApp<PreferencesHandlers>();

app.method('preferences/save', mutator(undoable(saveSyncedPrefs)));
app.method('preferences/get', getSyncedPrefs);
app.method('exchange-rates/get', getExchangeRate);
app.method('save-global-prefs', saveGlobalPrefs);
app.method('load-global-prefs', loadGlobalPrefs);
app.method('save-prefs', saveMetadataPrefs);
app.method('load-prefs', loadMetadataPrefs);
app.method('save-server-prefs', saveServerPrefs);

async function saveSyncedPrefs({
  id,
  value,
}: {
  id: keyof SyncedPrefs;
  value: string | undefined;
}) {
  if (!id) {
    return;
  }

  await db.update('preferences', {
    id,
    value,
  });
}

async function getSyncedPrefs(): Promise<SyncedPrefs> {
  const prefs = await db.all<Pick<db.DbPreference, 'id' | 'value'>>(
    'SELECT id, value FROM preferences',
  );

  return prefs.reduce<SyncedPrefs>((carry, { value, id }) => {
    if (!id.startsWith('exchange-rate:')) {
      carry[id as keyof SyncedPrefs] = value;
    }
    return carry;
  }, {});
}

type ExchangeRate = {
  source: string;
  target: string;
  rate: number;
  date: string;
  isCached: boolean;
};

export type ExchangeRateProvider = 'frankfurter' | 'bank-of-israel';

const supportedCurrencies = new Set<string>(exchangeRateCurrencies);

export async function getExchangeRate({
  source,
  target,
  date,
  provider = 'frankfurter',
}: {
  source: string;
  target: string;
  date?: string;
  provider?: ExchangeRateProvider;
}): Promise<ExchangeRate> {
  if (!supportedCurrencies.has(source) || !supportedCurrencies.has(target)) {
    throw new Error('Unsupported currency');
  }

  if (source === target) {
    return { source, target, rate: 1, date: '', isCached: false };
  }

  const requestedDate =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const latestCacheId = `exchange-rate:${provider}:${source}:${target}`;
  const cacheId = requestedDate
    ? `${latestCacheId}:${requestedDate}`
    : latestCacheId;
  const cached = await db.first<Pick<db.DbPreference, 'value'>>(
    'SELECT value FROM preferences WHERE id = ?',
    [cacheId],
  );
  const latestCached =
    cacheId === latestCacheId
      ? cached
      : await db.first<Pick<db.DbPreference, 'value'>>(
          'SELECT value FROM preferences WHERE id = ?',
          [latestCacheId],
        );

  const historicalQuery =
    requestedDate && requestedDate <= currentDay()
      ? `&from=${requestedDate}&to=${requestedDate}`
      : '';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const requestUrl =
      provider === 'bank-of-israel'
        ? (() => {
            const server = getServer();
            if (!server) {
              throw new Error(
                'Bank of Israel rates require a configured Actual server',
              );
            }
            const url = new URL(
              '/exchange-rates/bank-of-israel',
              server.BASE_SERVER,
            );
            url.searchParams.set('source', source);
            url.searchParams.set('target', target);
            if (requestedDate) {
              url.searchParams.set('date', requestedDate);
            }
            return url.toString();
          })()
        : `https://api.frankfurter.dev/v2/rates?base=${source}&quotes=${target}${historicalQuery}`;
    const response = await fetch(requestUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Exchange-rate request failed: ${response.status}`);
    }

    const responseData = await response.json();
    const data: {
      source: string;
      target: string;
      date: string;
      rate: number;
    } | null =
      provider === 'bank-of-israel'
        ? (responseData as {
            source: string;
            target: string;
            date: string;
            rate: number;
          })
        : (() => {
            const frankfurterRate = (
              responseData as Array<{
                date: string;
                base: string;
                quote: string;
                rate: number;
              }>
            )[0];
            return frankfurterRate
              ? {
                  source: frankfurterRate.base,
                  target: frankfurterRate.quote,
                  date: frankfurterRate.date,
                  rate: frankfurterRate.rate,
                }
              : null;
          })();
    const rate =
      data?.source === source && data.target === target
        ? data?.rate
        : undefined;
    if (!data?.date || !Number.isFinite(rate) || !rate || rate <= 0) {
      throw new Error('Exchange-rate response did not contain a valid rate');
    }

    const result: ExchangeRate = {
      source,
      target,
      rate,
      date: data.date,
      isCached: false,
    };
    await db.update('preferences', {
      id: cacheId,
      value: JSON.stringify(result),
    });
    if (cacheId !== latestCacheId) {
      await db.update('preferences', {
        id: latestCacheId,
        value: JSON.stringify(result),
      });
    }
    return result;
  } catch (error) {
    const fallback = cached ?? latestCached;
    if (fallback) {
      const result = JSON.parse(fallback.value) as ExchangeRate;
      return { ...result, isCached: true };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function saveGlobalPrefs(prefs: GlobalPrefs) {
  if (!prefs) {
    return 'ok';
  }

  if (prefs.maxMonths !== undefined) {
    await asyncStorage.setItem('max-months', '' + prefs.maxMonths);
  }
  if (prefs.categoryExpandedState !== undefined) {
    await asyncStorage.setItem(
      'category-expanded-state',
      '' + prefs.categoryExpandedState,
    );
  }
  if (prefs.documentDir !== undefined && (await fs.exists(prefs.documentDir))) {
    await asyncStorage.setItem('document-dir', prefs.documentDir);
  }
  if (prefs.floatingSidebar !== undefined) {
    await asyncStorage.setItem('floating-sidebar', '' + prefs.floatingSidebar);
  }
  if (prefs.language !== undefined) {
    await asyncStorage.setItem('language', prefs.language);
  }
  if (prefs.theme !== undefined) {
    await asyncStorage.setItem('theme', prefs.theme);
  }
  if (prefs.preferredDarkTheme !== undefined) {
    await asyncStorage.setItem(
      'preferred-dark-theme',
      prefs.preferredDarkTheme,
    );
  }
  if (prefs.installedCustomLightTheme !== undefined) {
    await asyncStorage.setItem(
      'installed-custom-theme',
      prefs.installedCustomLightTheme,
    );
  }
  if (prefs.installedCustomDarkTheme !== undefined) {
    await asyncStorage.setItem(
      'installed-custom-dark-theme',
      prefs.installedCustomDarkTheme,
    );
  }
  if (prefs.serverSelfSignedCert !== undefined) {
    await asyncStorage.setItem(
      'server-self-signed-cert',
      prefs.serverSelfSignedCert,
    );
  }
  if (prefs.syncServerConfig !== undefined) {
    await asyncStorage.setItem('syncServerConfig', prefs.syncServerConfig);
  }
  if (prefs.notifyWhenUpdateIsAvailable !== undefined) {
    await asyncStorage.setItem(
      'notifyWhenUpdateIsAvailable',
      prefs.notifyWhenUpdateIsAvailable,
    );
  }
  return 'ok';
}

async function loadGlobalPrefs(): Promise<GlobalPrefs> {
  const {
    'floating-sidebar': floatingSidebar,
    'category-expanded-state': categoryExpandedState,
    'max-months': maxMonths,
    'document-dir': documentDir,
    'encrypt-key': encryptKey,
    language,
    theme,
    'preferred-dark-theme': preferredDarkTheme,
    'installed-custom-theme': installedCustomLightTheme,
    'installed-custom-dark-theme': installedCustomDarkTheme,
    'server-self-signed-cert': serverSelfSignedCert,
    syncServerConfig,
    notifyWhenUpdateIsAvailable,
  } = await asyncStorage.multiGet([
    'floating-sidebar',
    'category-expanded-state',
    'max-months',
    'document-dir',
    'encrypt-key',
    'language',
    'theme',
    'preferred-dark-theme',
    'installed-custom-theme',
    'installed-custom-dark-theme',
    'server-self-signed-cert',
    'syncServerConfig',
    'notifyWhenUpdateIsAvailable',
  ] as const);
  return {
    floatingSidebar: floatingSidebar === 'true',
    categoryExpandedState: stringToInteger(categoryExpandedState || '') || 0,
    maxMonths: stringToInteger(maxMonths || '') || 1,
    documentDir: documentDir || getDefaultDocumentDir(),
    keyId: encryptKey && JSON.parse(encryptKey).id,
    language,
    theme:
      theme === 'light' ||
      theme === 'dark' ||
      theme === 'auto' ||
      theme === 'midnight'
        ? theme
        : 'auto',
    preferredDarkTheme:
      preferredDarkTheme === 'dark' || preferredDarkTheme === 'midnight'
        ? preferredDarkTheme
        : 'dark',
    installedCustomLightTheme: installedCustomLightTheme || undefined,
    installedCustomDarkTheme: installedCustomDarkTheme || undefined,
    serverSelfSignedCert: serverSelfSignedCert || undefined,
    syncServerConfig: syncServerConfig || undefined,
    notifyWhenUpdateIsAvailable:
      notifyWhenUpdateIsAvailable === undefined
        ? true
        : notifyWhenUpdateIsAvailable, // default to true
  };
}

async function saveMetadataPrefs(prefsToSet: MetadataPrefs) {
  if (!prefsToSet) {
    return 'ok';
  }

  const { cloudFileId } = _getMetadataPrefs();

  // Need to sync the budget name on the server as well
  if (prefsToSet.budgetName && cloudFileId) {
    const userToken = await asyncStorage.getItem('user-token');

    const syncServer = getServer()?.SYNC_SERVER;
    if (!syncServer) {
      throw new Error('No sync server set');
    }

    await post(syncServer + '/update-user-filename', {
      token: userToken,
      fileId: cloudFileId,
      name: prefsToSet.budgetName,
    });
  }

  await _saveMetadataPrefs(prefsToSet);
  return 'ok';
}

async function loadMetadataPrefs(): Promise<MetadataPrefs> {
  return _getMetadataPrefs();
}

async function saveServerPrefs({ prefs }: { prefs: Record<string, string> }) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return { error: 'not-logged-in' };
  }

  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    await post(serverConfig.SIGNUP_SERVER + '/server-prefs', {
      token: userToken,
      prefs,
    });
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  return {};
}
