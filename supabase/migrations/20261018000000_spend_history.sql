-- Monthly spend per category from before a bank was linked (imported via spend-history.js).
create table public.spend_history (
  user_id uuid not null references auth.users (id),
  month date not null check (month = date_trunc('month', month)::date),
  category text not null,
  spend_eur numeric not null check (spend_eur >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, month, category)
);

alter table public.spend_history enable row level security;

create policy "Users can view own spend history" on public.spend_history
  for select using ((select auth.uid()) = user_id);

-- Same columns as before, so create or replace is allowed. Imported months only fill in for
-- months with no live transactions, so linking a bank never double-counts.
create or replace view public.v_spend_by_category_monthly with (security_invoker = true) as
 select user_id,
    (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
    coalesce(category, 'Uncategorized'::text) as category,
    sum((- personal_signed_amount_eur)) as spend_eur
   from public.v_transactions_eur
  where ((personal_signed_amount_eur < (0)::numeric) and (flow_type = 'spend'::text))
  group by user_id, (date_trunc('month'::text, (booking_date)::timestamp with time zone)), coalesce(category, 'Uncategorized'::text)
 union all
 select h.user_id, h.month, h.category, h.spend_eur
   from public.spend_history h
  where not exists (
    select 1 from public.v_transactions_eur t
     where t.user_id = h.user_id
       and t.flow_type = 'spend'
       and (date_trunc('month'::text, (t.booking_date)::timestamp with time zone))::date = h.month
  );
