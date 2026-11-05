-- Your own categories. Everyone starts from the 13 built-in ones; a row here either adds a
-- category of your own (a name that isn't built in) or hides a built-in one you don't use
-- (hidden = true). Transfer and Income can't be hidden: transfers and income depend on them.
-- The dashboard's pickers and the AI categorizer both use the resulting list.
create table public.user_categories (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40 and name = btrim(name)),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, name),
  constraint user_categories_keep_transfer_income check (not (hidden and name in ('Transfer', 'Income')))
);

alter table public.user_categories enable row level security;

create policy "Users manage own categories" on public.user_categories
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.user_categories from anon;
grant select, insert, update, delete on public.user_categories to authenticated;
grant select, insert, update, delete on public.user_categories to service_role;
