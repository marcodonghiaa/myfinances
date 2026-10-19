drop policy "Users can view own pending bank consents" on public.pending_bank_consents;
create policy "Users can view own pending bank consents" on public.pending_bank_consents
  for select to authenticated using (auth.uid() = user_id);

drop policy "Users can create own pending bank consents" on public.pending_bank_consents;
create policy "Users can create own pending bank consents" on public.pending_bank_consents
  for insert to authenticated with check (auth.uid() = user_id);
