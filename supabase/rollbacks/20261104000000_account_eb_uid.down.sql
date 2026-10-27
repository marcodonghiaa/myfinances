-- Roll back the sync code and bank-consent-callback first: they read and write this column.
-- Accounts renewed since the migration lose their current EB id and fall back to `uid` until the next renewal.
alter table public.accounts drop column if exists eb_account_uid;
