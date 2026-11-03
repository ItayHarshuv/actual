// @ts-strict-ignore
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Form } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { FormError } from '@actual-app/components/form-error';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { InlineField } from '@actual-app/components/inline-field';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { exchangeRateCurrencies } from 'loot-core/shared/currencies';
import { toRelaxedNumber } from 'loot-core/shared/util';

import { useCreateAccountMutation } from '@desktop-client/accounts';
import { Link } from '@desktop-client/components/common/Link';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
  ModalTitle,
} from '@desktop-client/components/common/Modal';
import { Checkbox } from '@desktop-client/components/forms';
import { validateAccountName } from '@desktop-client/components/util/accountValidation';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { useCategories } from '@desktop-client/hooks/useCategories';
import { useNavigate } from '@desktop-client/hooks/useNavigate';
import { useSyncedPref } from '@desktop-client/hooks/useSyncedPref';
import { closeModal } from '@desktop-client/modals/modalsSlice';
import { useDispatch } from '@desktop-client/redux';

export function CreateLocalAccountModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { data: accounts = [] } = useAccounts();
  const { data: { list: categories } = { list: [] } } = useCategories();
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const [name, setName] = useState('');
  const [offbudget, setOffbudget] = useState(false);
  const [balance, setBalance] = useState('0');
  const [currency, setCurrency] = useState('');
  const [revaluationCategory, setRevaluationCategory] = useState('');

  const [nameError, setNameError] = useState(null);
  const [balanceError, setBalanceError] = useState(false);
  const [categoryError, setCategoryError] = useState(false);
  const selectedCurrency = currency || defaultCurrencyCode || '';
  const isSupportedBaseCurrency = exchangeRateCurrencies.some(
    candidate => candidate === defaultCurrencyCode,
  );
  const isForeignCurrency =
    isSupportedBaseCurrency &&
    selectedCurrency !== '' &&
    selectedCurrency !== defaultCurrencyCode;

  const validateBalance = balance => !isNaN(parseFloat(balance));

  const validateAndSetName = (name: string) => {
    const nameError = validateAccountName(name, '', accounts);
    if (nameError) {
      setNameError(nameError);
    } else {
      setName(name);
      setNameError(null);
    }
  };

  const createAccount = useCreateAccountMutation();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nameError = validateAccountName(name, '', accounts);

    const balanceError = !validateBalance(balance);
    setBalanceError(balanceError);
    const categoryError =
      isForeignCurrency && !offbudget && !revaluationCategory;
    setCategoryError(categoryError);

    if (!nameError && !balanceError && !categoryError) {
      createAccount.mutate(
        {
          name,
          balance: toRelaxedNumber(balance),
          offBudget: offbudget,
          currency: isForeignCurrency ? selectedCurrency : null,
          revaluationCategory:
            isForeignCurrency && !offbudget ? revaluationCategory : null,
        },
        {
          onSuccess: id => {
            dispatch(closeModal());
            void navigate('/accounts/' + id);
          },
        },
      );
    }
  };
  return (
    <Modal name="add-local-account">
      {({ state }) => (
        <>
          <ModalHeader
            title={
              <ModalTitle title={t('Create Local Account')} shrinkOnOverflow />
            }
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View>
            <Form onSubmit={onSubmit}>
              <InlineField label={t('Name')} width="100%">
                <InitialFocus>
                  <Input
                    name="name"
                    value={name}
                    onChangeValue={setName}
                    onUpdate={value => {
                      const name = value.trim();
                      validateAndSetName(name);
                    }}
                    style={{ flex: 1 }}
                  />
                </InitialFocus>
              </InlineField>
              {nameError && (
                <FormError style={{ marginLeft: 75, color: theme.warningText }}>
                  {nameError}
                </FormError>
              )}

              <InlineField label={t('Account currency')} width="100%">
                <Select
                  value={selectedCurrency}
                  onChange={setCurrency}
                  options={
                    isSupportedBaseCurrency
                      ? exchangeRateCurrencies.map(code => [
                          code,
                          code === defaultCurrencyCode
                            ? t('{{currency}} (budget currency)', {
                                currency: code,
                              })
                            : code,
                        ])
                      : [
                          [
                            defaultCurrencyCode || '',
                            defaultCurrencyCode || t('Budget currency'),
                          ],
                        ]
                  }
                  disabled={!isSupportedBaseCurrency}
                  style={{ flex: 1 }}
                />
              </InlineField>

              <View
                style={{
                  width: '100%',
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                }}
              >
                <View style={{ flexDirection: 'column' }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'flex-end',
                    }}
                  >
                    <Checkbox
                      id="offbudget"
                      name="offbudget"
                      checked={offbudget}
                      onChange={() => setOffbudget(!offbudget)}
                    />
                    <label
                      htmlFor="offbudget"
                      style={{
                        userSelect: 'none',
                        verticalAlign: 'center',
                      }}
                    >
                      <Trans>Off budget</Trans>
                    </label>
                  </View>
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: '0.7em',
                      color: theme.pageTextLight,
                      marginTop: 3,
                    }}
                  >
                    <Text>
                      <Trans>
                        This cannot be changed later. See{' '}
                        <Link
                          variant="external"
                          linkColor="muted"
                          to="https://actualbudget.org/docs/accounts/#off-budget-accounts"
                        >
                          Accounts Overview
                        </Link>{' '}
                        for more information.
                      </Trans>
                    </Text>
                  </div>
                </View>
              </View>

              {isForeignCurrency && !offbudget && (
                <>
                  <InlineField
                    label={t('Currency fluctuation category')}
                    width="100%"
                  >
                    <Select
                      value={revaluationCategory}
                      onChange={value => {
                        setRevaluationCategory(value);
                        setCategoryError(false);
                      }}
                      options={[
                        ['', t('Choose a category')],
                        ...categories
                          .filter(category => !category.is_income)
                          .map(
                            category => [category.id, category.name] as const,
                          ),
                      ]}
                      style={{ flex: 1 }}
                    />
                  </InlineField>
                  {categoryError && (
                    <FormError style={{ marginLeft: 75 }}>
                      <Trans>Choose a category for currency fluctuations</Trans>
                    </FormError>
                  )}
                </>
              )}

              <InlineField
                label={t('Balance ({{currency}})', {
                  currency: selectedCurrency,
                })}
                width="100%"
              >
                <Input
                  name="balance"
                  inputMode="decimal"
                  value={balance}
                  onChangeValue={setBalance}
                  onUpdate={value => {
                    const balance = value.trim();
                    setBalance(balance);
                    if (validateBalance(balance) && balanceError) {
                      setBalanceError(false);
                    }
                  }}
                  style={{ flex: 1 }}
                />
              </InlineField>
              {balanceError && (
                <FormError style={{ marginLeft: 75 }}>
                  <Trans>Balance must be a number</Trans>
                </FormError>
              )}

              <ModalButtons>
                <Button onPress={() => state.close()}>
                  <Trans>Back</Trans>
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  style={{ marginLeft: 10 }}
                >
                  <Trans>Create</Trans>
                </Button>
              </ModalButtons>
            </Form>
          </View>
        </>
      )}
    </Modal>
  );
}
