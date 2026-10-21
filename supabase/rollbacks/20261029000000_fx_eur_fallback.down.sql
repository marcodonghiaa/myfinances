-- Restores the inner-join definitions from the earlier migrations.
create or replace view public.v_net_worth_eur with (security_invoker = true) as
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

create or replace view public.v_cd_holdings with (security_invoker = true) as
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

create or replace view public.v_transactions_eur with (security_invoker = true) as
 select t.user_id,
    t.entry_reference,
    t.account_uid,
    t.booking_date,
    t.category,
    coalesce(t.custom_name, t.creditor_name) as creditor_name,
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

create or replace view public.v_splitwise_eur with (security_invoker = true) as
 select s.user_id,
    s.id,
    s.booking_date,
    s.category,
    s.description,
    s.group_name,
    s.currency,
    s.amount,
    s.amount * fx.rate_to_eur as amount_eur
   from public.splitwise_expenses s
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = s.currency and fx_rates.date <= s.booking_date
       order by fx_rates.date desc
       limit 1
     ) fx on true
  where s.linked_entry_reference is null;

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
