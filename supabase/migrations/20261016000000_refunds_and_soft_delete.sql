-- Refunds, soft delete of transactions, and dismissable subscriptions.
--   * flow_type 'refunded': a charge and the refund that reversed it. Both rows
--     stay visible in the dashboard but count as neither spend nor income (the
--     spend/income views already filter on flow_type = 'spend' / 'income').
--   * refund_of: on the refund row, the entry_reference of the charge it reverses.
--   * deleted_at: hide a transaction without a hard delete -- the bank sync
--     re-pulls 90 days of history and would resurrect a deleted row.
--   * dismissed: hide a merchant from the Subscriptions page.

alter table public.transactions
  add column refund_of text,
  add column deleted_at timestamptz;

alter table public.transactions drop constraint if exists transactions_flow_type_check;
alter table public.transactions
  add constraint transactions_flow_type_check
  check (flow_type in ('spend', 'income', 'transfer', 'refunded'));

alter table public.subscription_billing_overrides
  add column dismissed boolean not null default false;

-- v_transactions_eur: hide deleted rows, expose refund_of (new columns go last --
-- CREATE OR REPLACE VIEW cannot reorder existing ones).
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
    (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * coalesce(t.personal_amount, t.amount) * fx.rate_to_eur as personal_signed_amount_eur,
    coalesce(t.flow_type, case when t.credit_debit_indicator = 'DBIT' then 'spend' else 'income' end) as flow_type,
    t.personal_amount,
    t.owed_by,
    t.owed_settled,
    t.settled_at,
    t.refund_of
   from public.transactions t
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
       order by fx_rates.date desc
       limit 1
     ) fx on true
   where t.deleted_at is null;

-- v_subscriptions: only live charges (not deleted, not refunded, debits only --
-- a refund must never show up as the "last charge"), and skip dismissed merchants.
create or replace view public.v_subscriptions with (security_invoker = true) as
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
     and t.deleted_at is null
     and t.credit_debit_indicator = 'DBIT'
     and t.flow_type is distinct from 'refunded'
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
     left join public.subscription_billing_overrides o on o.user_id = w.user_id and o.creditor_name = w.creditor_name
   where coalesce(o.dismissed, false) = false;
