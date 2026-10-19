-- A name you give a transaction yourself. Stored apart from creditor_name because the bank sync
-- rewrites creditor_name every time it re-reads a transaction; the list view shows the custom
-- name when there is one.
alter table public.transactions add column custom_name text check (custom_name is null or char_length(custom_name) between 1 and 100);

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
