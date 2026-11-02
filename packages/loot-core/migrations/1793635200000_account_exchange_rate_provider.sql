BEGIN TRANSACTION;

ALTER TABLE accounts ADD COLUMN exchange_rate_provider TEXT DEFAULT 'frankfurter';

COMMIT;
