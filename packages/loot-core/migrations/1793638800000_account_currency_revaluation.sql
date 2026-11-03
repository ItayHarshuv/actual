BEGIN TRANSACTION;

ALTER TABLE accounts ADD COLUMN currency TEXT;
ALTER TABLE accounts ADD COLUMN revaluation_category TEXT;
ALTER TABLE accounts ADD COLUMN last_revaluation_check TEXT;
ALTER TABLE accounts ADD COLUMN last_revaluation_base_currency TEXT;
ALTER TABLE accounts ADD COLUMN last_revaluation_rate TEXT;
ALTER TABLE accounts ADD COLUMN last_revaluation_rate_date TEXT;
ALTER TABLE transactions ADD COLUMN is_currency_revaluation INTEGER DEFAULT 0;

COMMIT;
