-- Monthly budgets per category. A row sets a category's budget from its month onward, until a
-- later row changes it: set it once and every next month has it too. amount 0 means no budget
-- from that month. rollover carries the month's leftover (or overspend) into the next month for
-- as long as the latest row says so; turning it off starts the next month clean.
-- What counts as spent is the dashboard's spend by category (flow_type = 'spend', transfers and
-- income excluded), so no view is needed here.
create table public.category_budgets (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category text not null check (char_length(btrim(category)) between 1 and 40),
  month date not null check (extract(day from month) = 1),
  amount numeric(12, 2) not null check (amount >= 0 and amount < 10000000),
  rollover boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, category, month)
);

alter table public.category_budgets enable row level security;

create policy "Users manage own budgets" on public.category_budgets
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.category_budgets from anon;
grant select, insert, update, delete on public.category_budgets to authenticated;
grant select, insert, update, delete on public.category_budgets to service_role;
