BEGIN TRANSACTION;

ALTER TABLE transactions ADD COLUMN original_amount INTEGER;
ALTER TABLE transactions ADD COLUMN original_currency TEXT;
ALTER TABLE transactions ADD COLUMN exchange_rate TEXT;
ALTER TABLE transactions ADD COLUMN exchange_rate_date TEXT;

COMMIT;
