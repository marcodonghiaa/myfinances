-- Transactions typed in by hand (and, later, imported from a bank statement) for anyone without
-- a linked bank, or for cash. They live in the same transactions table, so spending, income,
-- filters and categorization treat them like bank rows.
--
-- A transaction needs an account (account_uid is part of the key), so each user gets one
-- "manual" account per source they name ("Fineco", "Cash"; "Manual" when left blank). Manual
-- accounts have no bank behind them: the bank sync skips them and the accounts list hides them.

alter table public.accounts add column manual boolean not null default false;

-- Bank rows stay read-only where the bank wrote them. A manual row is yours: its amount, date,
-- description, currency and direction can be changed. Keys and ownership never can.
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_manual boolean := exists (select 1 from accounts where uid = old.account_uid and manual);
begin
  if new.entry_reference is distinct from old.entry_reference
     or new.account_uid is distinct from old.account_uid
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.raw is distinct from old.raw
     or new.debtor_name is distinct from old.debtor_name
     or new.remittance_info is distinct from old.remittance_info
     or new.bank_transaction_code is distinct from old.bank_transaction_code
     or (not v_manual and (
          new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.credit_debit_indicator is distinct from old.credit_debit_indicator
       or new.creditor_name is distinct from old.creditor_name
       or new.booking_date is distinct from old.booking_date
       or new.value_date is distinct from old.value_date))
  then
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;

-- Adds one transaction by hand. Security definer because users cannot create accounts or
-- transactions themselves; every statement is pinned to auth.uid().
-- p_direction: 'DBIT' (money out) or 'CRDT' (money in). p_amount is positive.
-- A category is optional: left empty, the sync categorizes it (your rules first, then the AI).
-- Returns the new row's key.
create function public.add_manual_transaction(
  p_booking_date date,
  p_description text,
  p_amount numeric,
  p_direction text,
  p_currency text default 'EUR',
  p_category text default null,
  p_source text default null
) returns table (account_uid uuid, entry_reference text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_source text := coalesce(nullif(btrim(p_source), ''), 'Manual');
  v_currency text := upper(coalesce(nullif(btrim(p_currency), ''), 'EUR'));
  v_account uuid;
  v_ref text := 'manual-' || gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if p_booking_date is null then
    raise exception 'date is required';
  end if;
  if nullif(btrim(p_description), '') is null then
    raise exception 'description is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be above zero';
  end if;
  if p_direction not in ('DBIT', 'CRDT') then
    raise exception 'direction must be DBIT or CRDT';
  end if;

  select a.uid into v_account from accounts a
  where a.user_id = v_uid and a.manual and a.label = v_source and a.currency = v_currency;
  if v_account is null then
    insert into accounts (uid, user_id, currency, label, bank_name, manual)
    values (gen_random_uuid(), v_uid, v_currency, v_source, v_source, true)
    returning uid into v_account;
  end if;

  insert into transactions (
    entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator,
    creditor_name, booking_date, value_date, category, category_source, flow_type
  ) values (
    v_ref, v_account, v_uid, p_amount, v_currency, p_direction,
    btrim(p_description), p_booking_date, p_booking_date, p_category,
    case when p_category is not null then 'manual' end,
    case
      when p_category = 'Transfer' then 'transfer'
      when p_direction = 'DBIT' then 'spend'
      else 'income'
    end
  );

  return query select v_account, v_ref;
end;
$$;

revoke execute on function public.add_manual_transaction(date, text, numeric, text, text, text, text) from public, anon;
grant execute on function public.add_manual_transaction(date, text, numeric, text, text, text, text) to authenticated;

-- The accounts list shows bank accounts and their balances; manual accounts have neither.
create or replace view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur, a.bank_name, a.bank_logo, a.bank_country
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   where not a.manual
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;
