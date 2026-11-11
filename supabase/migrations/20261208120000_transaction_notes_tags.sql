-- Notes and tags: the user's own words on a transaction. Only the dashboard writes them (the
-- signed-in user, through RLS). The bank sync upserts only the columns its rows carry, and its rows
-- never carry note or tags, so a sync re-run leaves them as they are.

alter table public.transactions
  add column note text,
  add column tags text[] not null default '{}';

-- Bounds match the dashboard: a note up to 2000 characters, up to 20 tags of 1 to 40 characters
-- each (no spaces around them, single spaces inside, no tabs or line breaks), no NULL entries.
-- A CHECK can't hold a subquery, so the tag check is a function.
create function public.transaction_tags_ok(p_tags text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p_tags) <= 20
     and array_position(p_tags, null) is null
     and not exists (
       select 1 from unnest(p_tags) as t(tag)
       where char_length(t.tag) > 40 or t.tag !~ '^\S+( \S+)*$'
     );
$$;

alter table public.transactions
  add constraint transactions_note_length check (note is null or char_length(note) between 1 and 2000),
  add constraint transactions_tags_ok check (public.transaction_tags_ok(tags));

-- Same view as 20261029000000_fx_eur_fallback, plus note and tags at the end (appending keeps
-- the dependent views working).
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
    t.refund_of,
    t.note,
    t.tags
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
   where t.deleted_at is null;

-- Every tag the caller has used (all months), most used first: suggestions while typing a tag.
-- Invoker rights, so RLS applies too; the user_id filter lets it use the user_id index.
create function public.my_transaction_tags()
returns table (tag text, uses bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.tag, count(*) as uses
  from public.transactions tx
  cross join lateral unnest(tx.tags) as t(tag)
  where tx.user_id = (select auth.uid()) and tx.deleted_at is null
  group by t.tag
  order by count(*) desc, t.tag
  limit 500;
$$;

revoke execute on function public.my_transaction_tags() from public, anon;
grant execute on function public.my_transaction_tags() to authenticated;
