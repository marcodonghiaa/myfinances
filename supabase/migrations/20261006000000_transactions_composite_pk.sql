-- entry_reference alone is not unique across banks/users, and the sync
-- upserts with the service role on it -- a collision would overwrite another
-- account's row (user_id and all). Scope the key to the account.
alter table public.transactions
  drop constraint transactions_pkey,
  add primary key (account_uid, entry_reference);
