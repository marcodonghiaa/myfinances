-- Asserts for 20261205000000_lock_refund_of (local only). Runs in one rolled-back transaction, from the repo root:
--   T=supabase/migrations/20261205000000_lock_refund_of.sql
--   ( echo 'begin;'; cat $T supabase/rehearsals/lock_refund_of.assert.sql \
--       supabase/rollbacks/20261205000000_lock_refund_of.down.sql; cat $T supabase/rehearsals/lock_refund_of.assert.sql; \
--     echo 'rollback;' ) | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback must work, and the migration must apply again on top.
-- Rows are keyed by a random suffix so the file can run twice in one transaction.
select set_config('rehearsal.k', md5(random()::text), true);
insert into auth.users (id, email) select gen_random_uuid(), current_setting('rehearsal.k') || '-' || n || '@example.test'
  from generate_series(1, 2) n;
insert into public.accounts (uid, user_id, currency, label, manual)
  select gen_random_uuid(), id, 'EUR', 'rehearsal ' || email, false from auth.users
  where email like current_setting('rehearsal.k') || '-%';
insert into public.transactions (account_uid, entry_reference, user_id, amount, currency, credit_debit_indicator,
  booking_date, value_date, flow_type, flow_source, refund_of, raw)
select a.uid, current_setting('rehearsal.k') || v.ref || right(u.email, 14), u.id, 10, 'EUR', v.ind,
  '2026-10-01', '2026-10-01', v.flow, 'default',
  case when v.ref = 'cred' then current_setting('rehearsal.k') || 'chg' || right(u.email, 14) end, '{}'
from auth.users u join public.accounts a on a.user_id = u.id
cross join (values ('chg', 'DBIT', 'refunded'), ('cred', 'CRDT', 'refunded')) v(ref, ind, flow)
where u.email like current_setting('rehearsal.k') || '-%';

-- A signed-in user: refund_of is fixed, the fields they own still change, other users' rows are out of reach.
select set_config('rehearsal.a', (select id::text from auth.users where email = current_setting('rehearsal.k') || '-1@example.test'), true);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('rehearsal.a'), 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  begin
    update public.transactions set refund_of = 'other' where user_id::text = current_setting('rehearsal.a') and refund_of is not null;
    raise exception 'a signed-in user changed refund_of';
  exception when others then
    if sqlerrm like 'a signed-in user%' then raise; end if;
  end;
  begin
    update public.transactions set refund_of = null where user_id::text = current_setting('rehearsal.a') and refund_of is not null;
    raise exception 'a signed-in user cleared refund_of';
  exception when others then
    if sqlerrm like 'a signed-in user%' then raise; end if;
  end;
  update public.transactions set category = 'Shopping', flow_type = 'income'
    where user_id::text = current_setting('rehearsal.a') and refund_of is not null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a signed-in user could not change their own category and flow (% rows)', n; end if;
  update public.transactions set category = 'Hack'
    where entry_reference like current_setting('rehearsal.k') || '%' and user_id::text <> current_setting('rehearsal.a');
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a signed-in user changed another user''s rows (% rows)', n; end if;
end $$;
reset role;

-- The service role (refund pairing in post-sync) still writes refund_of.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare n int;
begin
  update public.transactions set refund_of = null where entry_reference like current_setting('rehearsal.k') || '%';
  get diagnostics n = row_count;
  if n <> 4 then raise exception 'the service role could not write refund_of (% rows)', n; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
