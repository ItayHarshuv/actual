import { Fragment, useRef, useState } from 'react';
import type { ComponentProps, CSSProperties } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import {
  SvgClose,
  SvgDotsHorizontalTriple,
  SvgLockOpen,
} from '@actual-app/components/icons/v1';
import { SvgNotesPaper } from '@actual-app/components/icons/v2';
import { InlineField } from '@actual-app/components/inline-field';
import { Input } from '@actual-app/components/input';
import { Menu } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { Select } from '@actual-app/components/select';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { exchangeRateCurrencies } from 'loot-core/shared/currencies';
import { integerToCurrency } from 'loot-core/shared/util';
import type { AccountEntity } from 'loot-core/types/models';

import {
  Modal,
  ModalCloseButton,
  ModalHeader,
  ModalTitle,
} from '@desktop-client/components/common/Modal';
import { Notes } from '@desktop-client/components/Notes';
import { validateAccountName } from '@desktop-client/components/util/accountValidation';
import { formatCurrencyAmount } from '@desktop-client/currency/transactionCurrency';
import { useAccount } from '@desktop-client/hooks/useAccount';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { useCategories } from '@desktop-client/hooks/useCategories';
import { useNotes } from '@desktop-client/hooks/useNotes';
import { useSyncedPref } from '@desktop-client/hooks/useSyncedPref';
import type { Modal as ModalType } from '@desktop-client/modals/modalsSlice';

type AccountMenuModalProps = Extract<
  ModalType,
  { name: 'account-menu' }
>['options'];

export function AccountMenuModal({
  accountId,
  onSave,
  onCloseAccount,
  onReopenAccount,
  onEditNotes,
  onClose,
  onToggleRunningBalance,
  onToggleReconciled,
}: AccountMenuModalProps) {
  const { t } = useTranslation();
  const account = useAccount(accountId);
  const { data: accounts = [] } = useAccounts();
  const { data: { list: categories } = { list: [] } } = useCategories();
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const originalNotes = useNotes(`account-${accountId}`);
  const [accountNameError, setAccountNameError] = useState('');
  const [currentAccountName, setCurrentAccountName] = useState(
    account?.name || t('New Account'),
  );
  const [conversionFeePercent, setConversionFeePercent] = useState(
    String(account?.conversion_fee_percent ?? 0),
  );

  const onRename = (newName: string) => {
    newName = newName.trim();
    if (!account) {
      return;
    }
    if (!newName) {
      setCurrentAccountName(t('Account'));
    } else {
      setCurrentAccountName(newName);
    }

    if (newName !== account.name) {
      const renameAccountError = validateAccountName(
        newName,
        accountId,
        accounts,
      );
      if (renameAccountError) {
        setAccountNameError(renameAccountError);
      } else {
        setAccountNameError('');
        onSave?.({
          ...account,
          name: newName,
        });
      }
    }
  };

  const _onEditNotes = () => {
    if (!account) {
      return;
    }

    onEditNotes?.(account.id);
  };

  const onConversionFeeUpdate = (value: string) => {
    if (!account) {
      return;
    }
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      setConversionFeePercent(String(account.conversion_fee_percent ?? 0));
      return;
    }

    const normalizedValue = Math.min(parsedValue, 100);
    setConversionFeePercent(String(normalizedValue));
    onSave?.({
      ...account,
      conversion_fee_percent: normalizedValue,
    });
  };

  const buttonStyle: CSSProperties = {
    ...styles.mediumText,
    height: styles.mobileMinHeight,
    color: theme.formLabelText,
    // Adjust based on desired number of buttons per row.
    flexBasis: '100%',
  };

  if (!account) {
    return null;
  }
  const accountCurrency = account.currency || defaultCurrencyCode || '';
  const isForeignCurrency =
    !!accountCurrency && accountCurrency !== defaultCurrencyCode;

  return (
    <Modal
      name="account-menu"
      onClose={onClose}
      containerProps={{
        style: {
          height: '45vh',
        },
      }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            leftContent={
              <AdditionalAccountMenu
                account={account}
                onClose={onCloseAccount}
                onReopen={onReopenAccount}
                onToggleRunningBalance={onToggleRunningBalance}
                onToggleReconciled={onToggleReconciled}
              />
            }
            title={
              <Fragment>
                <ModalTitle
                  isEditable
                  title={currentAccountName}
                  onTitleUpdate={onRename}
                />
                {accountNameError && (
                  <View style={{ color: theme.warningText }}>
                    {accountNameError}
                  </View>
                )}
              </Fragment>
            }
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View
            style={{
              flex: 1,
              flexDirection: 'column',
            }}
          >
            <InlineField
              label={t('Account currency')}
              width="100%"
              style={{ paddingBottom: 10 }}
            >
              <Select
                value={accountCurrency}
                onChange={value =>
                  onSave?.({
                    ...account,
                    currency:
                      !value || value === defaultCurrencyCode ? null : value,
                  })
                }
                options={exchangeRateCurrencies.map(currency => [
                  currency,
                  currency === defaultCurrencyCode
                    ? t('{{currency}} (budget currency)', { currency })
                    : currency,
                ])}
                style={{ flex: 1 }}
                disabled={!defaultCurrencyCode}
              />
            </InlineField>
            {isForeignCurrency && !account.offbudget && (
              <InlineField
                label={t('Currency fluctuation category')}
                width="100%"
                style={{ paddingBottom: 10 }}
              >
                <Select
                  value={account.revaluation_category || ''}
                  onChange={value =>
                    onSave?.({
                      ...account,
                      revaluation_category: value || null,
                    })
                  }
                  options={[
                    ['', t('Choose a category')],
                    ...categories
                      .filter(category => !category.is_income)
                      .map(category => [category.id, category.name] as const),
                  ]}
                  style={{ flex: 1 }}
                />
              </InlineField>
            )}
            <InlineField
              label={t('Exchange rate source')}
              width="100%"
              style={{ paddingBottom: 10 }}
            >
              <Select
                value={account.exchange_rate_provider ?? 'frankfurter'}
                onChange={value =>
                  onSave?.({
                    ...account,
                    exchange_rate_provider:
                      value === 'bank-of-israel'
                        ? 'bank-of-israel'
                        : 'frankfurter',
                  })
                }
                options={[
                  ['frankfurter', t('Frankfurter')],
                  ['bank-of-israel', t('Bank of Israel')],
                ]}
                style={{ flex: 1 }}
              />
            </InlineField>
            <InlineField
              label={t('Currency conversion fee (%)')}
              width="100%"
              style={{ paddingBottom: 10 }}
            >
              <Input
                value={conversionFeePercent}
                inputMode="decimal"
                onChangeValue={setConversionFeePercent}
                onUpdate={onConversionFeeUpdate}
                aria-label={t('Currency conversion fee percentage')}
                style={{ flex: 1 }}
              />
            </InlineField>
            {isForeignCurrency && (
              <Text
                style={{
                  ...styles.tnum,
                  color: theme.pageTextSubdued,
                  paddingBottom: account.currency_revaluation_date ? 4 : 10,
                }}
              >
                {t('Native balance: {{amount}}', {
                  amount: formatCurrencyAmount(
                    account.currency_native_balance ?? 0,
                    accountCurrency,
                  ),
                })}
              </Text>
            )}
            {isForeignCurrency && account.currency_revaluation_date && (
              <Text
                style={{
                  ...styles.tnum,
                  color: theme.pageTextSubdued,
                  paddingBottom: 10,
                }}
              >
                {t('Current currency adjustment: {{amount}} · {{date}}', {
                  amount: integerToCurrency(
                    account.currency_revaluation_amount ?? 0,
                  ),
                  date: account.currency_revaluation_date,
                })}
              </Text>
            )}
            <View
              style={{
                overflowY: 'auto',
                flex: 1,
              }}
            >
              <Notes
                notes={
                  originalNotes && originalNotes.length > 0
                    ? originalNotes
                    : t('No notes')
                }
                editable={false}
                focused={false}
                getStyle={() => ({
                  borderRadius: 6,
                  ...((!originalNotes || originalNotes.length === 0) && {
                    justifySelf: 'center',
                    alignSelf: 'center',
                    color: theme.pageTextSubdued,
                  }),
                })}
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignContent: 'space-between',
                paddingTop: 10,
              }}
            >
              <Button style={buttonStyle} onPress={_onEditNotes}>
                <SvgNotesPaper
                  width={20}
                  height={20}
                  style={{ paddingRight: 5 }}
                />
                <Trans>Edit notes</Trans>
              </Button>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}

type AdditionalAccountMenuProps = {
  account: AccountEntity;
  onClose?: (accountId: string) => void;
  onReopen?: (accountId: string) => void;
  onToggleRunningBalance?: () => void;
  onToggleReconciled?: () => void;
};

function AdditionalAccountMenu({
  account,
  onClose,
  onReopen,
  onToggleRunningBalance,
  onToggleReconciled,
}: AdditionalAccountMenuProps) {
  const { t } = useTranslation();
  const triggerRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const itemStyle: CSSProperties = {
    ...styles.mediumText,
    height: styles.mobileMinHeight,
  };

  const getItemStyle: ComponentProps<typeof Menu>['getItemStyle'] = item => ({
    ...itemStyle,
    ...(item.name === 'close' && { color: theme.errorTextMenu }),
  });
  const [showBalances] = useSyncedPref(`show-balances-${account.id}`);
  const [hideReconciled] = useSyncedPref(`hide-reconciled-${account.id}`);

  return (
    <View>
      <Button
        ref={triggerRef}
        variant="bare"
        aria-label={t('Menu')}
        onPress={() => {
          setMenuOpen(true);
        }}
      >
        <SvgDotsHorizontalTriple
          width={17}
          height={17}
          style={{ color: 'currentColor' }}
        />
        <Popover
          triggerRef={triggerRef}
          isOpen={menuOpen}
          placement="bottom start"
          onOpenChange={() => setMenuOpen(false)}
        >
          <Menu
            getItemStyle={getItemStyle}
            items={[
              {
                name: 'balance',
                text:
                  showBalances === 'true'
                    ? t('Hide running balance')
                    : t('Show running balance'),
              },
              {
                name: 'toggle-reconciled',
                text:
                  hideReconciled !== 'true'
                    ? t('Hide reconciled transactions')
                    : t('Show reconciled transactions'),
              },
              account.closed
                ? {
                    name: 'reopen',
                    text: t('Reopen account'),
                    icon: SvgLockOpen,
                    iconSize: 15,
                  }
                : {
                    name: 'close',
                    text: t('Close account'),
                    icon: SvgClose,
                    iconSize: 15,
                  },
            ]}
            onMenuSelect={name => {
              setMenuOpen(false);
              switch (name) {
                case 'close':
                  onClose?.(account.id);
                  break;
                case 'reopen':
                  onReopen?.(account.id);
                  break;
                case 'balance':
                  onToggleRunningBalance?.();
                  break;
                case 'toggle-reconciled':
                  onToggleReconciled?.();
                  break;
                default:
                  throw new Error(`Unrecognized menu option: ${String(name)}`);
              }
            }}
          />
        </Popover>
      </Button>
    </View>
  );
}
