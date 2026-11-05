-- Two view fixes from the audit.
--
-- v_spend_by_category_monthly: a month with imported totals (spend_history) and Splitwise shares
-- but no bank spend returned two rows for the same category, so Spending listed it twice. The
-- rows are now summed into one per category; the month's total is unchanged.
--
-- v_subscriptions: a shared plan counted at full price while Spending counts your share. It now
-- uses your share (personal_amount) when one is set, like v_transactions_eur.

create or replace view public.v_spend_by_category_monthly with (security_invoker = true) as
 select u.user_id, u.month, u.category, sum(u.spend_eur) as spend_eur
   from (
 select live.user_id, live.month, live.category, sum(live.spend_eur) as spend_eur
   from (
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
        coalesce(category, 'Uncategorized'::text) as category,
        (- personal_signed_amount_eur) as spend_eur
       from public.v_transactions_eur
      where ((personal_signed_amount_eur < (0)::numeric) and (flow_type = 'spend'::text))
     union all
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date,
        coalesce(category, 'Uncategorized'::text),
        amount_eur
       from public.v_splitwise_eur
   ) live
  group by live.user_id, live.month, live.category
 union all
 select h.user_id, h.month, h.category, h.spend_eur
   from public.spend_history h
  where not exists (
    select 1 from public.v_transactions_eur t
     where t.user_id = h.user_id
       and t.flow_type = 'spend'
       and (date_trunc('month'::text, (t.booking_date)::timestamp with time zone))::date = h.month
  )
   ) u
  group by u.user_id, u.month, u.category;

create or replace view public.v_subscriptions with (security_invoker = true) as
 with subscription_charges as (
   select t.user_id, t.creditor_name, t.category, t.currency, t.amount, t.booking_date,
     (case when t.credit_debit_indicator = 'DBIT' then -1 else 1 end)::numeric * coalesce(t.personal_amount, t.amount) * fx.rate_to_eur as signed_amount_eur,
     row_number() over (partition by t.user_id, t.creditor_name order by t.booking_date desc) as rn
   from public.transactions t
     left join lateral (
        select coalesce(
          (select fx_rates.rate_to_eur
           from public.fx_rates
           where fx_rates.currency = t.currency and fx_rates.date <= t.booking_date
           order by fx_rates.date desc
           limit 1),
          case when t.currency = 'EUR' then 1::numeric end
        ) as rate_to_eur
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
