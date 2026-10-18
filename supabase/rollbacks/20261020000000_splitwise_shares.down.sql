-- Manual rollback for 20261020000000_splitwise_shares.sql. Not a migration: run it by hand
-- only if the Splitwise import must be removed completely. Views are restored to the definitions
-- that were live before the migration.
--
-- Before running: undo imports from the app first if you want the bank transactions put back
-- (personal_amount / flow_type). This script clears the import tag but does NOT revert them.
-- Dropping splitwise_expenses permanently deletes every imported share.

begin;

create or replace view public.v_income_vs_expenses_monthly with (security_invoker = true) as
 select user_id,
    date_trunc('month'::text, booking_date::timestamp with time zone)::date as month,
    sum(case when flow_type = 'income'::text and personal_signed_amount_eur > 0::numeric
             then personal_signed_amount_eur else 0::numeric end) as income_eur,
    sum(case when flow_type = 'spend'::text and personal_signed_amount_eur < 0::numeric
             then - personal_signed_amount_eur else 0::numeric end) as expenses_eur
   from v_transactions_eur
  group by user_id, (date_trunc('month'::text, booking_date::timestamp with time zone))
  order by (date_trunc('month'::text, booking_date::timestamp with time zone)::date);

create or replace view public.v_spend_by_category_monthly with (security_invoker = true) as
 select v_transactions_eur.user_id,
    date_trunc('month'::text, v_transactions_eur.booking_date::timestamp with time zone)::date as month,
    coalesce(v_transactions_eur.category, 'Uncategorized'::text) as category,
    sum(- v_transactions_eur.personal_signed_amount_eur) as spend_eur
   from v_transactions_eur
  where v_transactions_eur.personal_signed_amount_eur < 0::numeric
    and v_transactions_eur.flow_type = 'spend'::text
  group by v_transactions_eur.user_id,
    (date_trunc('month'::text, v_transactions_eur.booking_date::timestamp with time zone)),
    (coalesce(v_transactions_eur.category, 'Uncategorized'::text))
 union all
 select h.user_id, h.month, h.category, h.spend_eur
   from spend_history h
  where not exists (
    select 1 from v_transactions_eur t
     where t.user_id = h.user_id
       and t.flow_type = 'spend'::text
       and date_trunc('month'::text, t.booking_date::timestamp with time zone)::date = h.month);

drop function if exists public.import_splitwise(uuid, text, date, date, jsonb, jsonb);
drop function if exists public.undo_splitwise_import(uuid);
drop view if exists public.v_splitwise_eur;
drop table if exists public.splitwise_expenses;

drop index if exists public.transactions_user_import_batch_idx;
alter table public.transactions drop column if exists import_batch_id;

commit;
