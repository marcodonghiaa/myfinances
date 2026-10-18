-- Lets the app's CSV import write the two history tables from the browser, under owner-only RLS.
-- batch_id tags every row of one import so it can be undone. other_eur holds a net worth total
-- that has no per-class breakdown.
alter table public.net_worth_history
  add column batch_id uuid,
  add column other_eur numeric not null default 0;

alter table public.spend_history
  add column batch_id uuid;

create index net_worth_history_user_batch_idx on public.net_worth_history (user_id, batch_id);
create index spend_history_user_batch_idx on public.spend_history (user_id, batch_id);

create policy "Users can insert own net worth history" on public.net_worth_history
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own net worth history" on public.net_worth_history
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own net worth history" on public.net_worth_history
  for delete using ((select auth.uid()) = user_id);

create policy "Users can insert own spend history" on public.spend_history
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own spend history" on public.spend_history
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own spend history" on public.spend_history
  for delete using ((select auth.uid()) = user_id);
