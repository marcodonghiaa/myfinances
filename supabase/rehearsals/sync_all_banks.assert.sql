-- Asserts for 20261117000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   M=supabase/migrations/20261117000000_sync_all_banks.sql
--   ( echo 'begin;'; cat $M supabase/rehearsals/sync_all_banks.assert.sql \
--       supabase/rollbacks/20261117000000_sync_all_banks.down.sql; \
--     echo "select to_regprocedure('public.sync_all_banks()') is null as dropped;"; cat $M; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. Nothing is sent: pg_net only queues requests, and the rollback drops them.
do $$
declare
  n int;
  queued int;
begin
  -- Without the Vault secrets it refuses instead of calling with a null URL or key.
  begin
    perform public.sync_all_banks();
    raise exception 'expected the missing-secrets error';
  exception when raise_exception then
    if sqlerrm not like 'Set the Vault secrets%' then raise; end if;
  end;

  perform vault.create_secret('http://127.0.0.1:9/', 'project_url');
  perform vault.create_secret('sb_secret_test', 'sync_bank_secret_key');
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'c1@example.test');
  insert into public.accounts (uid, user_id, currency, label) values
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'EUR', 'A'),
    ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'USD', 'B');

  -- One queued request per account, to sync-bank, with the key on apikey and a 150 s timeout.
  select count(*) into n from public.sync_all_banks();
  if n <> (select count(*) from public.accounts) then raise exception 'one request per account, got %', n; end if;
  select count(*) into queued from net.http_request_queue
   where url = 'http://127.0.0.1:9/functions/v1/sync-bank'
     and headers ->> 'apikey' = 'sb_secret_test'
     and timeout_milliseconds = 150000
     and convert_from(body, 'utf8')::jsonb ->> 'account_uid' in
       ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
  if queued <> 2 then raise exception 'expected 2 queued sync-bank requests for the seeded accounts, got %', queued; end if;
end $$;

-- API roles can't start a run.
do $$
begin
  if has_function_privilege('anon', 'public.sync_all_banks()', 'execute')
     or has_function_privilege('authenticated', 'public.sync_all_banks()', 'execute')
     or has_function_privilege('service_role', 'public.sync_all_banks()', 'execute') then
    raise exception 'an API role can execute sync_all_banks';
  end if;
end $$;
