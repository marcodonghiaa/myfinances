-- Notes and tags on transactions: the user's own words, never the bank's.
-- The sync upserts only the bank columns it maps (transaction-rows), so a re-sync never
-- touches these two. restrict_transaction_updates blocks bank fields only, so users can edit them.
-- Adding a column with a constant default is metadata only; the GIN index is small (one row per
-- transaction) and builds inside the migration's transaction.
set local lock_timeout = '5s';

alter table public.transactions
  add column note text check (note is null or char_length(note) between 1 and 2000),
  add column tags text[] not null default '{}'
    check (cardinality(tags) <= 20 and char_length(array_to_string(tags, '')) <= 800 and array_position(tags, null) is null and array_position(tags, '') is null);

-- Filter by tag: tags @> '{tag}'.
create index transactions_tags_idx on public.transactions using gin (tags);

-- Same view as 20261029000000_fx_eur_fallback, plus note and tags at the end
-- (create or replace view may only append columns).
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

-- Every tag the caller has used, most used first, for the tag picker's suggestions.
create function public.my_transaction_tags()
returns table (tag text, uses bigint)
language sql
stable
security invoker
set search_path to ''
as $$
  select u.tag, count(*) as uses
    from public.transactions t, unnest(t.tags) as u(tag)
   where t.user_id = (select auth.uid()) and t.deleted_at is null
   group by u.tag
   order by uses desc, u.tag;
$$;
revoke execute on function public.my_transaction_tags() from public, anon;
grant execute on function public.my_transaction_tags() to authenticated;
