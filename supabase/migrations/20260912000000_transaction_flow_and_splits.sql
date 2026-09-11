-- Transaction flow classification (spend / income / transfer) and expense
-- splitting (personal_amount / owed_by), for:
--   1. Excluding internal transfers (currency exchange, wallet top-ups) from
--      spend/income analytics -- they're not real income or spend, just your
--      own money moving.
--   2. Splitting a transaction you fronted for others (e.g. a group flight
--      booking) so only your actual share counts toward your spend.

alter table public.transactions
  add column personal_amount numeric,
  add column owed_by text,
  add column owed_settled boolean not null default false,
  add column settled_at timestamptz,
  add column flow_type text check (flow_type in ('spend', 'income', 'transfer'));

-- ============================================================================
-- v_transactions_eur: expose the new columns, plus a personal-share EUR
-- figure (coalesce(personal_amount, amount) -- NULL personal_amount means
-- "the whole amount is mine", today's default) and a resolved flow_type
-- (explicit value if set, else derived from credit_debit_indicator).
-- ============================================================================

create or replace view public.v_transactions_eur with (security_invoker = true) as
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
    t.worth_it,
    -- New columns must come after the pre-existing ones -- CREATE OR REPLACE
    -- VIEW refuses to reorder/rename positional columns.
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * coalesce(t.personal_amount, t.amount) * fx.rate_to_eur as personal_signed_amount_eur,
    coalesce(t.flow_type, case when t.credit_debit_indicator = 'DBIT' then 'spend' else 'income' end) as flow_type,
    t.personal_amount,
    t.owed_by,
    t.owed_settled,
    t.settled_at
   from public.transactions t
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
       order by fx_rates.date desc
       limit 1
     ) fx on true;

-- ============================================================================
-- v_spend_by_category_monthly: personal share only, real spend only
-- (excludes transfers -- a currency exchange or wallet top-up was never
-- "spend" in the first place).
-- ============================================================================

create or replace view public.v_spend_by_category_monthly with (security_invoker = true) as
 select user_id,
    date_trunc('month', booking_date::timestamptz)::date as month,
    coalesce(category, 'Uncategorized') as category,
    sum(-personal_signed_amount_eur) as spend_eur
   from public.v_transactions_eur
   where personal_signed_amount_eur < 0 and flow_type = 'spend'
   group by user_id, date_trunc('month', booking_date::timestamptz), coalesce(category, 'Uncategorized')
   order by date_trunc('month', booking_date::timestamptz)::date, coalesce(category, 'Uncategorized');

-- ============================================================================
-- v_income_vs_expenses_monthly: same personal-share + transfer-exclusion
-- logic, both sides.
-- ============================================================================

create or replace view public.v_income_vs_expenses_monthly with (security_invoker = true) as
 select user_id,
    date_trunc('month', booking_date::timestamptz)::date as month,
    sum(case when flow_type = 'income' and personal_signed_amount_eur > 0 then personal_signed_amount_eur else 0 end) as income_eur,
    sum(case when flow_type = 'spend' and personal_signed_amount_eur < 0 then -personal_signed_amount_eur else 0 end) as expenses_eur
   from public.v_transactions_eur
   group by user_id, date_trunc('month', booking_date::timestamptz)
   order by date_trunc('month', booking_date::timestamptz)::date;
