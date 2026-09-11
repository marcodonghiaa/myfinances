-- OPTIONAL: public read-only /demo mode.
--
-- Only apply this if you want an unauthenticated demo page backed by one
-- seeded "guest" account, like the one this project ships publicly. Not
-- required to run the app for yourself -- skip this file entirely if you
-- don't want a public demo.
--
-- Before running: create a real Supabase Auth user to act as the guest
-- (e.g. via the dashboard or `supabase.auth.admin.createUser`), seed it with
-- whatever sample data you want visible, then replace the placeholder UUID
-- below with that user's id. Every policy here is SELECT-only, scoped to
-- exactly that one user id, for the `anon` role -- it can never see or
-- write anyone else's data, and can never write anything at all.

do $$
declare
  guest_id uuid := '00000000-0000-0000-0000-000000000000'; -- replace with your guest user's id
begin
  execute format('create policy "Demo: anon can view guest accounts" on public.accounts for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest transactions" on public.transactions for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest net worth" on public.net_worth_snapshots for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest portfolio holdings" on public.portfolio_holdings for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest portfolio snapshots" on public.portfolio_snapshots for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest crypto holdings" on public.crypto_holdings for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest crypto snapshots" on public.crypto_snapshots for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest category rules" on public.category_rules for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest cd holdings" on public.cd_holdings for select to anon using (user_id = %L)', guest_id);
  execute format('create policy "Demo: anon can view guest billing overrides" on public.subscription_billing_overrides for select to anon using (user_id = %L)', guest_id);
end $$;

-- fx_rates is shared reference data (no user_id), safe to expose fully.
create policy "Demo: anon can view fx rates" on public.fx_rates
  for select to anon using (true);
