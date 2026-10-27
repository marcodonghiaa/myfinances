-- The bank behind each account (Enable Banking's ASPSP name and country, plus its logo URL from
-- /aspsps), so the dashboard and the expiry push name the bank instead of the holder name EB returns
-- as the account name. Null until bank-consent-callback stores it on the next connect or renewal.
-- Safe to re-run (add column if not exists, create or replace view).

alter table public.accounts
  add column if not exists bank_name text,
  add column if not exists bank_country text,
  add column if not exists bank_logo text;

-- Same as the initial schema, with bank_name and bank_logo appended (a replaced view can only add
-- columns at the end).
create or replace view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur, a.bank_name, a.bank_logo
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;
