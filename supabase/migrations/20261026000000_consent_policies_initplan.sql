-- Supabase's performance linter (auth_rls_initplan) flags the select and insert policies on
-- pending_bank_consents: a bare auth.uid() is re-evaluated for every row, while
-- (select auth.uid()) is evaluated once per query. Same rule as every other table's policies.
-- Behaviour is unchanged.

drop policy "Users can view own pending bank consents" on public.pending_bank_consents;
create policy "Users can view own pending bank consents" on public.pending_bank_consents
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy "Users can create own pending bank consents" on public.pending_bank_consents;
create policy "Users can create own pending bank consents" on public.pending_bank_consents
  for insert to authenticated with check ((select auth.uid()) = user_id);
