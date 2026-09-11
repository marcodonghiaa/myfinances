-- Initial schema for the finance dashboard.
--
-- Exported from the live project via introspection (no direct DB credentials
-- were available to run a real pg_dump) -- this is a faithful reconstruction
-- of the current production schema, not a redesign. Core tables, indexes,
-- RLS, and views only; the optional public-demo-mode policies live in a
-- separate migration since they're specific to running a public /demo page,
-- not something every self-hoster needs.

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ============================================================================
-- Tables
-- ============================================================================

create table public.accounts (
  uid uuid primary key,
  iban text,
  currency text not null,
  label text,
  created_at timestamptz default now(),
  user_id uuid not null references auth.users (id),
  consent_valid_until timestamptz,
  identification_hash text
);

create table public.transactions (
  entry_reference text primary key,
  account_uid uuid references public.accounts (uid),
  amount numeric not null,
  currency text not null,
  credit_debit_indicator text,
  creditor_name text,
  debtor_name text,
  remittance_info text,
  booking_date date,
  value_date date,
  bank_transaction_code text,
  category text,
  raw jsonb,
  created_at timestamptz default now(),
  user_id uuid not null references auth.users (id),
  transaction_type text check (transaction_type in ('Subscription', 'One-time')),
  worth_it_prompted_at timestamptz,
  worth_it text check (worth_it in ('yes', 'no'))
);

create table public.net_worth_snapshots (
  id bigint generated always as identity primary key,
  account_uid uuid references public.accounts (uid),
  currency text not null,
  amount numeric not null,
  eur_equivalent numeric,
  snapshot_date date not null,
  created_at timestamptz default now(),
  user_id uuid not null references auth.users (id),
  constraint unique_account_snapshot_date unique (account_uid, snapshot_date)
);

create table public.fx_rates (
  date date not null,
  currency text not null,
  rate_to_eur numeric not null,
  created_at timestamptz not null default now(),
  primary key (date, currency)
);

create table public.portfolio_holdings (
  user_id uuid not null references auth.users (id),
  isin text not null,
  yahoo_symbol text not null,
  name text not null,
  shares numeric not null,
  broker_label text not null default 'Trade Republic',
  created_at timestamptz not null default now(),
  asset_type text,
  primary key (user_id, isin)
);

create table public.portfolio_snapshots (
  user_id uuid not null,
  isin text not null,
  snapshot_date date not null,
  price numeric not null,
  currency text not null,
  value_native numeric not null,
  value_eur numeric,
  created_at timestamptz not null default now(),
  primary key (user_id, isin, snapshot_date),
  foreign key (user_id, isin) references public.portfolio_holdings (user_id, isin)
);

create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  match_field text not null check (match_field in ('creditor_name', 'remittance_info', 'any')),
  match_text text not null,
  set_category text,
  set_transaction_type text check (set_transaction_type in ('Subscription', 'One-time') or set_transaction_type is null),
  priority integer not null default 100,
  created_at timestamptz not null default now()
);

create table public.subscription_billing_overrides (
  user_id uuid not null references auth.users (id),
  creditor_name text not null,
  billing_frequency text check (billing_frequency in ('Weekly', 'Monthly', 'Quarterly', 'Yearly')),
  created_at timestamptz not null default now(),
  custom_interval_value integer,
  custom_interval_unit text check (custom_interval_unit in ('days', 'weeks', 'months', 'years')),
  primary key (user_id, creditor_name)
);

create table public.crypto_holdings (
  user_id uuid not null references auth.users (id),
  asset_symbol text not null,
  name text not null,
  amount numeric not null,
  source text not null check (source in ('Ledger', 'Coinbase')),
  coingecko_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, asset_symbol, source)
);

create table public.crypto_snapshots (
  user_id uuid not null,
  asset_symbol text not null,
  source text not null,
  snapshot_date date not null,
  amount numeric not null,
  price_usd numeric not null,
  value_usd numeric not null,
  value_eur numeric,
  created_at timestamptz not null default now(),
  primary key (user_id, asset_symbol, source, snapshot_date),
  foreign key (user_id, asset_symbol, source) references public.crypto_holdings (user_id, asset_symbol, source)
);

create table public.cd_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  label text not null,
  bank_label text,
  currency text not null,
  principal numeric not null check (principal > 0),
  annual_rate numeric not null check (annual_rate >= 0),
  start_date date not null,
  maturity_date date not null,
  created_at timestamptz not null default now(),
  constraint cd_holdings_maturity_after_start check (maturity_date > start_date)
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table public.pending_bank_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Indexes (primary keys already index themselves; these cover FK lookups
-- the app actually queries by)
-- ============================================================================

create index idx_accounts_user_id on public.accounts (user_id);
create index idx_category_rules_user_id on public.category_rules (user_id);
create index idx_cd_holdings_user_id on public.cd_holdings (user_id);
create index idx_net_worth_snapshots_user_id on public.net_worth_snapshots (user_id);
create index idx_transactions_account_uid on public.transactions (account_uid);
create index idx_transactions_user_id on public.transactions (user_id);

-- ============================================================================
-- Row Level Security -- every table is owner-only. No public/anon access
-- here; that's the separate optional demo-mode migration.
-- ============================================================================

alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.net_worth_snapshots enable row level security;
alter table public.fx_rates enable row level security;
alter table public.portfolio_holdings enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.category_rules enable row level security;
alter table public.subscription_billing_overrides enable row level security;
alter table public.crypto_holdings enable row level security;
alter table public.crypto_snapshots enable row level security;
alter table public.cd_holdings enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.pending_bank_consents enable row level security;

create policy "Users can view own accounts" on public.accounts
  for select using ((select auth.uid()) = user_id);

create policy "Users can view own transactions" on public.transactions
  for select using ((select auth.uid()) = user_id);
create policy "Users can update own transactions" on public.transactions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Users can view own net worth" on public.net_worth_snapshots
  for select using ((select auth.uid()) = user_id);

create policy "Authenticated users can view fx rates" on public.fx_rates
  for select using ((select auth.role()) = 'authenticated');

create policy "Users can view own portfolio holdings" on public.portfolio_holdings
  for select using ((select auth.uid()) = user_id);

create policy "Users can view own portfolio snapshots" on public.portfolio_snapshots
  for select using ((select auth.uid()) = user_id);

create policy "Users can view own rules" on public.category_rules
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own rules" on public.category_rules
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own rules" on public.category_rules
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own rules" on public.category_rules
  for delete using ((select auth.uid()) = user_id);

create policy "Users can view own billing overrides" on public.subscription_billing_overrides
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own billing overrides" on public.subscription_billing_overrides
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own billing overrides" on public.subscription_billing_overrides
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own billing overrides" on public.subscription_billing_overrides
  for delete using ((select auth.uid()) = user_id);

create policy "Users can view own crypto holdings" on public.crypto_holdings
  for select using ((select auth.uid()) = user_id);

create policy "Users can view own crypto snapshots" on public.crypto_snapshots
  for select using ((select auth.uid()) = user_id);

create policy "Users can view own cds" on public.cd_holdings
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own cds" on public.cd_holdings
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own cds" on public.cd_holdings
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own cds" on public.cd_holdings
  for delete using ((select auth.uid()) = user_id);

create policy "Users can view own push subscriptions" on public.push_subscriptions
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own push subscriptions" on public.push_subscriptions
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can delete own push subscriptions" on public.push_subscriptions
  for delete using ((select auth.uid()) = user_id);

create policy "Users can view own pending bank consents" on public.pending_bank_consents
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can create own pending bank consents" on public.pending_bank_consents
  for insert to authenticated with check (auth.uid() = user_id);

-- ============================================================================
-- Views. security_invoker=true on every one -- without it, RLS is checked
-- against the view OWNER's access, not the querying user's, which is a real
-- cross-user data leak (hit and fixed once already on this project).
-- ============================================================================

create view public.v_transactions_eur with (security_invoker = true) as
 select t.user_id,
    t.entry_reference,
    t.account_uid,
    t.booking_date,
    t.category,
    t.creditor_name,
    t.currency,
    t.amount,
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * t.amount * fx.rate_to_eur as signed_amount_eur,
    t.transaction_type,
    t.credit_debit_indicator,
    t.created_at,
    t.worth_it
   from public.transactions t
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
       order by fx_rates.date desc
       limit 1
     ) fx on true;

create view public.v_net_worth_eur with (security_invoker = true) as
 select nws.user_id,
    nws.account_uid,
    nws.snapshot_date,
    nws.currency,
    nws.amount,
    nws.amount * fx.rate_to_eur as amount_eur
   from public.net_worth_snapshots nws
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = nws.currency and fx_rates.date <= nws.snapshot_date
       order by fx_rates.date desc
       limit 1
     ) fx on true;

create view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;

create view public.v_cd_holdings with (security_invoker = true) as
 select c.id, c.user_id, c.label, c.bank_label, c.currency, c.principal, c.annual_rate,
    c.start_date, c.maturity_date,
    (c.maturity_date <= current_date) as is_matured,
    (least(current_date, c.maturity_date) - c.start_date) as days_elapsed,
    c.principal * power(1 + c.annual_rate, (least(current_date, c.maturity_date) - c.start_date)::numeric / 365.25) as current_value_native,
    (c.principal * power(1 + c.annual_rate, (least(current_date, c.maturity_date) - c.start_date)::numeric / 365.25)) * fx.rate_to_eur as current_value_eur
   from public.cd_holdings c
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = c.currency and fx_rates.date <= current_date
       order by fx_rates.date desc
       limit 1
     ) fx on true;

create view public.v_crypto_latest with (security_invoker = true) as
 select distinct on (h.user_id, h.asset_symbol, h.source)
    h.user_id, h.asset_symbol, h.name, h.amount, h.source,
    s.snapshot_date, s.price_usd, s.value_usd, s.value_eur
   from public.crypto_holdings h
     join public.crypto_snapshots s on s.user_id = h.user_id and s.asset_symbol = h.asset_symbol and s.source = h.source
   order by h.user_id, h.asset_symbol, h.source, s.snapshot_date desc;

create view public.v_portfolio_latest with (security_invoker = true) as
 select distinct on (h.user_id, h.isin)
    h.user_id, h.isin, h.name, h.shares, h.broker_label,
    s.snapshot_date, s.price, s.currency, s.value_native, s.value_eur, h.asset_type
   from public.portfolio_holdings h
     join public.portfolio_snapshots s on s.user_id = h.user_id and s.isin = h.isin
   order by h.user_id, h.isin, s.snapshot_date desc;

create view public.v_net_worth_daily with (security_invoker = true) as
 with all_dates as (
   select user_id, snapshot_date from public.net_worth_snapshots
   union
   select user_id, snapshot_date from public.portfolio_snapshots
   union
   select user_id, snapshot_date from public.crypto_snapshots
 )
 select d.user_id, d.snapshot_date,
    coalesce(b.bank_total_eur, 0) + coalesce(p.portfolio_total_eur, 0) + coalesce(c.crypto_total_eur, 0) as total_eur,
    coalesce(b.bank_total_eur, 0) as bank_total_eur,
    coalesce(p.portfolio_total_eur, 0) as portfolio_total_eur,
    coalesce(c.crypto_total_eur, 0) as crypto_total_eur
   from (select distinct user_id, snapshot_date from all_dates) d
     left join lateral (
       select sum(e.amount_eur) as bank_total_eur
       from public.v_net_worth_eur e
       where e.user_id = d.user_id
         and e.snapshot_date = (select max(e2.snapshot_date) from public.v_net_worth_eur e2 where e2.user_id = d.user_id and e2.snapshot_date <= d.snapshot_date)
       group by e.user_id
     ) b on true
     left join lateral (
       select sum(ps.value_eur) as portfolio_total_eur
       from public.portfolio_snapshots ps
       where ps.user_id = d.user_id
         and ps.snapshot_date = (select max(ps2.snapshot_date) from public.portfolio_snapshots ps2 where ps2.user_id = d.user_id and ps2.snapshot_date <= d.snapshot_date)
       group by ps.user_id
     ) p on true
     left join lateral (
       select sum(cs.value_eur) as crypto_total_eur
       from public.crypto_snapshots cs
       where cs.user_id = d.user_id
         and cs.snapshot_date = (select max(cs2.snapshot_date) from public.crypto_snapshots cs2 where cs2.user_id = d.user_id and cs2.snapshot_date <= d.snapshot_date)
       group by cs.user_id
     ) c on true
   order by d.snapshot_date;

create view public.v_spend_by_category_monthly with (security_invoker = true) as
 select user_id,
    date_trunc('month', booking_date::timestamptz)::date as month,
    coalesce(category, 'Uncategorized') as category,
    sum(-signed_amount_eur) as spend_eur
   from public.v_transactions_eur
   where signed_amount_eur < 0
   group by user_id, date_trunc('month', booking_date::timestamptz), coalesce(category, 'Uncategorized')
   order by date_trunc('month', booking_date::timestamptz)::date, coalesce(category, 'Uncategorized');

create view public.v_income_vs_expenses_monthly with (security_invoker = true) as
 select user_id,
    date_trunc('month', booking_date::timestamptz)::date as month,
    sum(case when signed_amount_eur > 0 then signed_amount_eur else 0 end) as income_eur,
    sum(case when signed_amount_eur < 0 then -signed_amount_eur else 0 end) as expenses_eur
   from public.v_transactions_eur
   group by user_id, date_trunc('month', booking_date::timestamptz)
   order by date_trunc('month', booking_date::timestamptz)::date;

create view public.v_subscriptions with (security_invoker = true) as
 with subscription_charges as (
   select t.user_id, t.creditor_name, t.category, t.currency, t.amount, t.booking_date,
     (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * t.amount * fx.rate_to_eur as signed_amount_eur,
     row_number() over (partition by t.user_id, t.creditor_name order by t.booking_date desc) as rn
   from public.transactions t
     join lateral (
       select fx_rates.rate_to_eur from public.fx_rates
       where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
       order by fx_rates.date desc limit 1
     ) fx on true
   where t.transaction_type = 'Subscription'
 ),
 charge_counts as (
   select user_id, creditor_name, count(*) as charge_count
   from subscription_charges group by user_id, creditor_name
 ),
 latest as (
   select user_id, creditor_name, category, currency, amount, booking_date, signed_amount_eur, rn
   from subscription_charges where rn = 1
 ),
 previous as (
   select user_id, creditor_name, booking_date as prev_charged
   from subscription_charges where rn = 2
 ),
 with_interval as (
   select latest.user_id, latest.creditor_name, latest.category, latest.currency, latest.amount,
     latest.signed_amount_eur, latest.booking_date as last_charged, cc.charge_count,
     (latest.booking_date - previous.prev_charged) as interval_days
   from latest
     join charge_counts cc using (user_id, creditor_name)
     left join previous using (user_id, creditor_name)
 ),
 with_auto_frequency as (
   select *,
     case
       when interval_days is null then null
       when interval_days between 5 and 10 then 'Weekly'
       when interval_days between 24 and 40 then 'Monthly'
       when interval_days between 75 and 105 then 'Quarterly'
       when interval_days between 330 and 395 then 'Yearly'
       else null
     end as auto_billing_frequency
   from with_interval
 )
 select w.user_id, w.creditor_name, w.category, w.currency, w.amount, w.signed_amount_eur,
    w.last_charged, w.charge_count, w.interval_days,
    case when o.custom_interval_value is not null then 'Custom'
         else coalesce(o.billing_frequency, w.auto_billing_frequency) end as billing_frequency,
    (o.billing_frequency is not null or o.custom_interval_value is not null) as billing_frequency_is_manual,
    w.signed_amount_eur / case
      when o.custom_interval_value is not null then
        (o.custom_interval_value::numeric * case o.custom_interval_unit
          when 'days' then 1 when 'weeks' then 7 when 'months' then 30.437 when 'years' then 365.25
          else null end) / 30.437
      else case coalesce(o.billing_frequency, w.auto_billing_frequency)
        when 'Weekly' then 0.230137 when 'Quarterly' then 3 when 'Yearly' then 12 else 1 end
    end as monthly_equivalent_eur,
    o.custom_interval_value, o.custom_interval_unit
   from with_auto_frequency w
     left join public.subscription_billing_overrides o on o.user_id = w.user_id and o.creditor_name = w.creditor_name;
