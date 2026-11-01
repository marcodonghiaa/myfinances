-- Asserts for 20261109000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   T=supabase/migrations/20261109000000_splitwise_corrections.sql
--   ( echo 'begin;'; cat $T supabase/rehearsals/splitwise_corrections.assert.sql \
--       supabase/rollbacks/20261109000000_splitwise_corrections.down.sql; \
--     echo "select to_regprocedure('public.apply_splitwise_corrections(uuid,text,jsonb,jsonb,jsonb)') is null as dropped;"; \
--     cat $T; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback must work, and the migration must apply again on top.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'c1@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'c2@example.test');
insert into public.accounts (uid, user_id, currency) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'USD');
insert into public.transactions (account_uid, entry_reference, amount, currency, user_id, flow_type, personal_amount, import_batch_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'rm', 100, 'USD', '00000000-0000-0000-0000-0000000000c1', 'spend', 25, '00000000-0000-0000-0000-0000000000b0'),
  ('00000000-0000-0000-0000-0000000000a1', 'ed', 99.35, 'USD', '00000000-0000-0000-0000-0000000000c1', 'spend', 20, '00000000-0000-0000-0000-0000000000b0'),
  ('00000000-0000-0000-0000-0000000000a1', 'keep', 50, 'USD', '00000000-0000-0000-0000-0000000000c1', 'spend', 10, '00000000-0000-0000-0000-0000000000b0'),
  ('00000000-0000-0000-0000-0000000000a1', 'settle', 30, 'USD', '00000000-0000-0000-0000-0000000000c1', 'transfer', null, '00000000-0000-0000-0000-0000000000b0');
insert into public.splitwise_expenses (id, user_id, group_name, fingerprint, booking_date, description, category, amount, currency, batch_id, linked_account_uid, linked_entry_reference) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c1', 'g', 'rm#1', '2026-10-01', 'rm', 'Food', 25, 'USD', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a1', 'rm'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000c1', 'g', 'ed#1', '2026-10-02', 'ed', 'Mine', 20, 'USD', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a1', 'ed'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000000c1', 'g', 'keep#1', '2026-10-03', 'keep', 'Food', 10, 'USD', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a1', 'keep'),
  ('00000000-0000-0000-0000-00000000e004', '00000000-0000-0000-0000-0000000000c2', 'g', 'other#1', '2026-10-03', 'other', 'Food', 10, 'USD', '00000000-0000-0000-0000-0000000000b0', null, null);

-- anon cannot execute
do $$ begin
  assert not has_function_privilege('anon', 'public.apply_splitwise_corrections(uuid,text,jsonb,jsonb,jsonb)', 'execute'), 'anon can execute';
  assert has_function_privilege('authenticated', 'public.apply_splitwise_corrections(uuid,text,jsonb,jsonb,jsonb)', 'execute'), 'authenticated cannot execute';
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

-- A row changed since the review: the whole call fails, including the valid removal before it.
do $$ begin
  begin
    perform public.apply_splitwise_corrections('00000000-0000-0000-0000-0000000000b1', 'g', '[]',
      '[{"id":"00000000-0000-0000-0000-00000000e002","old_fingerprint":"stale","fingerprint":"x","booking_date":"2026-10-02","description":"x","amount":1,"currency":"USD","cost":2}]',
      '[{"id":"00000000-0000-0000-0000-00000000e001","old_fingerprint":"rm#1"}]');
    assert false, 'stale edit must fail';
  exception when raise_exception then
    assert sqlerrm like 'A stored expense changed%', sqlerrm;
  end;
  assert (select count(*) from splitwise_expenses where id = '00000000-0000-0000-0000-00000000e001') = 1, 'removal rolled back';
  assert (select personal_amount from transactions where entry_reference = 'rm') = 25, 'bank rolled back';
end $$;

-- A missing cost cannot null a personal amount.
do $$ begin
  begin
    perform public.apply_splitwise_corrections('00000000-0000-0000-0000-0000000000b1', 'g', '[]',
      '[{"id":"00000000-0000-0000-0000-00000000e002","old_fingerprint":"ed#1","fingerprint":"x","booking_date":"2026-10-02","description":"x","amount":1,"currency":"USD"}]',
      '[]');
    assert false, 'missing cost must fail';
  exception when raise_exception then
    assert sqlerrm like 'An edit has no valid cost%', sqlerrm;
  end;
end $$;

-- Another user's row cannot be named.
do $$ begin
  begin
    perform public.apply_splitwise_corrections('00000000-0000-0000-0000-0000000000b1', 'g', '[]', '[]',
      '[{"id":"00000000-0000-0000-0000-00000000e004","old_fingerprint":"other#1"}]');
    assert false, 'other user must fail';
  exception when raise_exception then null;
  end;
end $$;

select public.apply_splitwise_corrections('00000000-0000-0000-0000-0000000000b1', 'g',
  '[{"fingerprint":"late#1","booking_date":"2026-09-30","description":"late","category":null,"amount":7,"currency":"USD"}]',
  '[{"id":"00000000-0000-0000-0000-00000000e002","old_fingerprint":"ed#1","fingerprint":"ed2#1","booking_date":"2026-10-02","description":"ed2","amount":24.75,"currency":"USD","cost":99}]',
  '[{"id":"00000000-0000-0000-0000-00000000e001","old_fingerprint":"rm#1"}]');

do $$ begin
  -- Removal: the share is gone, the bank counts in full again, and its flow type stays.
  assert (select count(*) from splitwise_expenses where id = '00000000-0000-0000-0000-00000000e001') = 0, 'removed';
  assert (select personal_amount is null and import_batch_id is null and flow_type = 'spend' from transactions where entry_reference = 'rm'), 'bank after removal';
  -- Edit: new values, same bank link and batch, category kept, personal amount recalculated.
  assert (select fingerprint = 'ed2#1' and amount = 24.75 and category = 'Mine' and batch_id = '00000000-0000-0000-0000-0000000000b0' and linked_entry_reference = 'ed' from splitwise_expenses where id = '00000000-0000-0000-0000-00000000e002'), 'edited row';
  assert (select personal_amount from transactions where entry_reference = 'ed') = 24.84, 'bank after edit';
  -- Added: its own batch, no link.
  assert (select batch_id = '00000000-0000-0000-0000-0000000000b1' and linked_entry_reference is null from splitwise_expenses where fingerprint = 'late#1'), 'added row';
  -- Nothing named stays as it was, settle-up included.
  assert (select amount = 10 and batch_id = '00000000-0000-0000-0000-0000000000b0' from splitwise_expenses where id = '00000000-0000-0000-0000-00000000e003'), 'unnamed share';
  assert (select personal_amount = 10 from transactions where entry_reference = 'keep'), 'unnamed bank';
  assert (select flow_type = 'transfer' and import_batch_id = '00000000-0000-0000-0000-0000000000b0' from transactions where entry_reference = 'settle'), 'settle-up';
end $$;

-- Not covered by Undo: undoing the corrections' batch is never offered, and undoing the old batch
-- removes what is left of it but not the row added late.
select public.undo_splitwise_import('00000000-0000-0000-0000-0000000000b0');
do $$ begin
  assert (select count(*) from splitwise_expenses where fingerprint = 'late#1') = 1, 'late row survives Undo';
end $$;

reset role;
