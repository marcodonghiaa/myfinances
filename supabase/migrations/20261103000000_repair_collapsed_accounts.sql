-- Repairs Revolut accounts collapsed by bug U25: one row kept pocket 1's uid (so its snapshots are
-- pocket 1's) but got the last pocket's currency and identification_hash. Currency comes back from
-- the newest snapshot; the hash is cleared so the next Renew access re-matches by IBAN + currency
-- and recreates the missing pockets as their own rows. Safe to re-run: a repaired row matches its
-- snapshots and is skipped (UPDATE 0).

update public.accounts a
set currency = s.currency, identification_hash = null
from (
  select distinct on (account_uid) account_uid, currency
  from public.net_worth_snapshots
  order by account_uid, snapshot_date desc
) s
where s.account_uid = a.uid and s.currency <> a.currency;

-- One row per pocket: the sync callback treats a 23505 on this index as "already linked".
create unique index if not exists accounts_user_identification_hash_key
  on public.accounts (user_id, identification_hash)
  where identification_hash is not null;
