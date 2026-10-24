-- Investments and crypto could only be added in SQL: users could read their holdings but not
-- write them. Let a signed-in user add, edit and remove their own rows, the same rules cd_holdings
-- already has. Prices (the *_snapshots tables) stay read-only for users: the add-holding Edge
-- Function and the price sync write them with the service role.
--
-- A holding with price history can't be deleted (the snapshots reference it); the app marks it
-- sold instead (shares / amount 0), which keeps past net worth correct.

create policy "Users can insert own portfolio holdings" on public.portfolio_holdings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own portfolio holdings" on public.portfolio_holdings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own portfolio holdings" on public.portfolio_holdings
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users can insert own crypto holdings" on public.crypto_holdings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own crypto holdings" on public.crypto_holdings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own crypto holdings" on public.crypto_holdings
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Crypto added from the app has neither a Ledger nor a Coinbase source.
-- The check was declared inline, so drop it by what it checks rather than by its generated name.
do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.crypto_holdings'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%source%'
  loop
    execute format('alter table public.crypto_holdings drop constraint %I', c);
  end loop;
end $$;
alter table public.crypto_holdings add constraint crypto_holdings_source_check
  check (source in ('Ledger', 'Coinbase', 'Manual'));

-- The broker defaulted to the maintainer's own; new rows get it from the app instead.
alter table public.portfolio_holdings alter column broker_label drop default;
