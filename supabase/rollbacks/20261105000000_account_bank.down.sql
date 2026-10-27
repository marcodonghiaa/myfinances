-- Roll back bank-consent-callback, the expiry push and the dashboard first: they read and write these columns.
-- Drop and recreate the view from the initial schema (create or replace cannot drop columns), then drop the columns.
begin;
drop view if exists public.v_bank_accounts_latest;
create view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;

alter table public.accounts
  drop column if exists bank_name,
  drop column if exists bank_country,
  drop column if exists bank_logo;
commit;
