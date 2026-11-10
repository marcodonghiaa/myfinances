-- Account types: credit cards and loans are debts and subtract from net worth; a debt can be
-- typed in by hand.
--
-- accounts.account_type comes from the bank (Enable Banking cash_account_type) on link and is
-- filled once by the sync for accounts linked before. null = unknown, counted like checking.
-- The user can correct it (set_account_type).

alter table public.accounts add column if not exists account_type text;
-- Some databases may already carry a check under this name: replace it.
alter table public.accounts drop constraint if exists accounts_account_type_check;
alter table public.accounts add constraint accounts_account_type_check
  check (account_type in ('checking', 'savings', 'credit_card', 'loan', 'investment', 'other'));

-- Net worth: a debt account (credit_card, loan) counts -abs(balance), whatever sign its bank
-- uses. bank_total_eur keeps the other accounts only; liabilities_eur (new, last column, a
-- positive amount) is the debt, and total_eur subtracts it. A manual account's balance is typed
-- in by hand, so it carries forward without the 30-day limit bank balances have.
create or replace view public.v_net_worth_daily
with (security_invoker = true) as
with all_dates as (
  select net_worth_snapshots.user_id, net_worth_snapshots.snapshot_date from net_worth_snapshots
  union
  select portfolio_snapshots.user_id, portfolio_snapshots.snapshot_date from portfolio_snapshots
  union
  select crypto_snapshots.user_id, crypto_snapshots.snapshot_date from crypto_snapshots
)
select
  d.user_id,
  d.snapshot_date,
  coalesce(b.bank_total_eur, 0) + coalesce(cd.cd_total_eur, 0) + coalesce(p.portfolio_total_eur, 0) + coalesce(c.crypto_total_eur, 0)
    - coalesce(b.liabilities_eur, 0) as total_eur,
  coalesce(b.bank_total_eur, 0) + coalesce(cd.cd_total_eur, 0) as bank_total_eur,
  coalesce(p.portfolio_total_eur, 0) as portfolio_total_eur,
  coalesce(c.crypto_total_eur, 0) as crypto_total_eur,
  coalesce(p.portfolio_bonds_eur, 0) as portfolio_bonds_eur,
  coalesce(b.liabilities_eur, 0) as liabilities_eur
from (select distinct all_dates.user_id, all_dates.snapshot_date from all_dates) d
left join lateral (
  select
    sum(x.amount_eur) filter (where not x.is_debt) as bank_total_eur,
    sum(abs(x.amount_eur)) filter (where x.is_debt) as liabilities_eur
  from (
    select distinct on (e.account_uid) e.account_uid, e.amount_eur,
      coalesce(a.account_type in ('credit_card', 'loan'), false) as is_debt
    from v_net_worth_eur e
    join accounts a on a.uid = e.account_uid
    where e.user_id = d.user_id
      and e.snapshot_date <= d.snapshot_date
      and (e.snapshot_date > d.snapshot_date - 31 or a.manual)
    order by e.account_uid, e.snapshot_date desc
  ) x
) b on true
left join lateral (
  select sum(
    cd.principal
    * power(1 + cd.annual_rate, (d.snapshot_date - cd.start_date)::numeric / 365.25)
    * coalesce(
        (select r.rate_to_eur from fx_rates r
         where r.currency = cd.currency and r.date <= d.snapshot_date
         order by r.date desc limit 1),
        case when cd.currency = 'EUR' then 1::numeric end)
  ) as cd_total_eur
  from cd_holdings cd
  where cd.user_id = d.user_id
    and cd.start_date <= d.snapshot_date
    and cd.maturity_date > d.snapshot_date
) cd on true
left join lateral (
  select
    sum(x.value_eur) as portfolio_total_eur,
    sum(x.value_eur) filter (where exists (
      select 1 from portfolio_holdings h
      where h.user_id = x.user_id and h.isin = x.isin and h.asset_type = 'Bond'
    )) as portfolio_bonds_eur
  from (
    select distinct on (ps.isin) ps.user_id, ps.isin, ps.snapshot_date, ps.value_eur
    from portfolio_snapshots ps
    where ps.user_id = d.user_id and ps.snapshot_date <= d.snapshot_date
    order by ps.isin, ps.snapshot_date desc
  ) x
  where x.snapshot_date = (
      select max(ps2.snapshot_date) from portfolio_snapshots ps2
      where ps2.user_id = d.user_id and ps2.snapshot_date <= d.snapshot_date
    )
    or exists (
      select 1 from portfolio_holdings h
      where h.user_id = x.user_id and h.isin = x.isin
    )
) p on true
left join lateral (
  select sum(y.value_eur) as crypto_total_eur
  from (
    select distinct on (cs.asset_symbol, cs.source)
      cs.user_id, cs.asset_symbol, cs.source, cs.snapshot_date, cs.value_eur
    from crypto_snapshots cs
    where cs.user_id = d.user_id and cs.snapshot_date <= d.snapshot_date
    order by cs.asset_symbol, cs.source, cs.snapshot_date desc
  ) y
  where y.snapshot_date = (
      select max(cs2.snapshot_date) from crypto_snapshots cs2
      where cs2.user_id = d.user_id and cs2.snapshot_date <= d.snapshot_date
    )
    or exists (
      select 1 from crypto_holdings h
      where h.user_id = y.user_id and h.asset_symbol = y.asset_symbol and h.source = y.source
    )
) c on true
order by d.snapshot_date;

-- The accounts list: bank accounts, plus manual accounts that have a balance (debts typed in
-- by hand). Manual accounts that only hold typed-in transactions stay hidden. account_type and
-- manual are new, last columns. amount is the raw balance: debts show as -abs(amount).
create or replace view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur, a.bank_name, a.bank_logo, a.bank_country,
    a.account_type, a.manual
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   where not a.manual or e.snapshot_date is not null
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;

-- Correct an account's type (the bank can be wrong). null = unknown again. Security definer
-- because users cannot update accounts themselves; the update is pinned to auth.uid().
create function public.set_account_type(p_account uuid, p_type text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if p_type is not null and p_type not in ('checking', 'savings', 'credit_card', 'loan', 'investment', 'other') then
    raise exception 'unknown account type';
  end if;
  update accounts set account_type = p_type where uid = p_account and user_id = v_uid;
  if not found then
    raise exception 'account not found';
  end if;
end;
$$;

revoke execute on function public.set_account_type(uuid, text) from public, anon;
grant execute on function public.set_account_type(uuid, text) to authenticated;

-- Sets today's balance of one of the caller's manual accounts. Security definer because users
-- cannot write balances themselves; bank accounts keep the balance their bank reports.
create function public.set_manual_balance(p_account uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_account accounts%rowtype;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if p_amount is null then
    raise exception 'amount is required';
  end if;
  select * into v_account from accounts where uid = p_account and user_id = v_uid;
  if not found then
    raise exception 'account not found';
  end if;
  if not v_account.manual then
    raise exception 'not a manual account';
  end if;
  insert into net_worth_snapshots (account_uid, user_id, currency, amount, snapshot_date)
  values (v_account.uid, v_uid, v_account.currency, p_amount, current_date)
  on conflict (account_uid, snapshot_date) do update set amount = excluded.amount;
end;
$$;

revoke execute on function public.set_manual_balance(uuid, numeric) from public, anon;
grant execute on function public.set_manual_balance(uuid, numeric) to authenticated;

-- A debt typed in by hand: a manual account of type loan with today's balance. Returns its uid.
create function public.add_manual_debt(p_name text, p_amount numeric, p_currency text default 'EUR')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := nullif(btrim(p_name), '');
  v_currency text := upper(coalesce(nullif(btrim(p_currency), ''), 'EUR'));
  v_account uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if v_name is null then
    raise exception 'name is required';
  end if;
  if char_length(v_name) > 100 then
    raise exception 'name is too long';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be a 3-letter code';
  end if;
  if p_amount is null then
    raise exception 'amount is required';
  end if;
  insert into accounts (uid, user_id, currency, label, manual, account_type)
  values (v_account, v_uid, v_currency, v_name, true, 'loan');
  insert into net_worth_snapshots (account_uid, user_id, currency, amount, snapshot_date)
  values (v_account, v_uid, v_currency, p_amount, current_date);
  return v_account;
end;
$$;

revoke execute on function public.add_manual_debt(text, numeric, text) from public, anon;
grant execute on function public.add_manual_debt(text, numeric, text) to authenticated;

-- Typed-in transactions never land in a debt account that happens to share their source name:
-- they get a manual account of their own. Same body as 20261111, plus the type check.
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
