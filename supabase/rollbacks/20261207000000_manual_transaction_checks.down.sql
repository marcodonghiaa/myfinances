-- Rollback of 20261207000000_manual_transaction_checks: add_manual_transaction as 20261130 left it.
create or replace function public.add_manual_transaction(
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
  where a.user_id = v_uid and a.manual and a.label = v_source and a.currency = v_currency
    and coalesce(a.account_type, 'checking') not in ('credit_card', 'loan');
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
