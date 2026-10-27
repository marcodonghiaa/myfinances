-- The current Enable Banking session's account id; null means `uid` is that id. EB account ids are only
-- valid while their session is authorized, so a renewal brings a new id while `uid` stays the primary
-- key that transactions and snapshots reference. Safe to re-run (add column if not exists).

alter table public.accounts add column if not exists eb_account_uid uuid;
