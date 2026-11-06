-- Asserts for 20261118000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   ( echo 'begin;'; cat supabase/migrations/20261117000000_sync_all_banks.sql \
--       supabase/migrations/20261118000000_schedule_sync.sql supabase/rehearsals/schedule_sync.assert.sql \
--       supabase/rollbacks/20261118000000_schedule_sync.down.sql supabase/rollbacks/20261118000000_schedule_sync.down.sql; \
--     echo "select count(*) = 0 as unscheduled from cron.job where jobname in ('sync-banks','post-sync','sync-prices','notify-worth-it','notify-consent');"; \
--     cat supabase/migrations/20261118000000_schedule_sync.sql; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. Nothing is sent: pg_net only queues requests, and the rollback drops them.
do $$
declare
  n int;
begin
  -- The five jobs, at the sync.yml times (UTC), each with the command it should run.
  select count(*) into n from cron.job where (jobname, schedule, command) in (
    ('sync-banks', '17 */6 * * *', 'select public.sync_all_banks()'),
    ('post-sync', '32 */6 * * *', $c$select public.call_edge_function('post-sync')$c$),
    ('sync-prices', '37 */6 * * *', $c$select public.call_edge_function('sync-prices')$c$),
    ('notify-worth-it', '42 * * * *', $c$select public.call_edge_function('notify', '{"job":"worth-it"}')$c$),
    ('notify-consent', '3 8 * * *', $c$select public.call_edge_function('notify', '{"job":"consent"}')$c$));
  if n <> 5 then raise exception 'expected the 5 scheduled jobs with their commands, got %', n; end if;

  -- Refuses without the Vault secrets, and refuses anything that isn't a function name.
  begin
    perform public.call_edge_function('post-sync');
    raise exception 'expected the missing-secrets error';
  exception when raise_exception then
    if sqlerrm not like 'Set the Vault secrets%' then raise; end if;
  end;
  perform vault.create_secret('http://127.0.0.1:9/', 'project_url');
  perform vault.create_secret('sb_secret_test', 'sync_bank_secret_key');
  begin
    perform public.call_edge_function('../../auth/v1/admin');
    raise exception 'expected the bad-name error';
  exception when raise_exception then
    if sqlerrm not like 'Not an Edge Function name%' then raise; end if;
  end;

  -- Queues one POST with the key on apikey, the body given and a 150 s timeout.
  perform public.call_edge_function('notify', '{"job":"consent"}');
  select count(*) into n from net.http_request_queue
   where url = 'http://127.0.0.1:9/functions/v1/notify' and headers ->> 'apikey' = 'sb_secret_test'
     and timeout_milliseconds = 150000 and convert_from(body, 'utf8')::jsonb = '{"job":"consent"}';
  if n <> 1 then raise exception 'expected 1 queued notify request, got %', n; end if;

  -- Every job command runs as written (as the role that scheduled it) and queues its request.
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'd1@example.test');
  insert into public.accounts (uid, user_id, currency, label)
    values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'EUR', 'A');
  for n in select jobid from cron.job where jobname in ('sync-banks', 'post-sync', 'sync-prices', 'notify-worth-it', 'notify-consent') loop
    execute (select command from cron.job where jobid = n);
  end loop;
  select count(*) into n from net.http_request_queue where url like 'http://127.0.0.1:9/functions/v1/%';
  if n < 1 + 5 then raise exception 'expected every job to queue a request, got %', n; end if;
  if not exists (select 1 from net.http_request_queue where url like '%/functions/v1/sync-prices')
     or not exists (select 1 from net.http_request_queue where convert_from(body, 'utf8')::jsonb = '{"job":"worth-it"}') then
    raise exception 'a job queued the wrong request';
  end if;

  -- Nobody but the owner can call it (it carries the secret key).
  if has_function_privilege('public', 'public.call_edge_function(text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.call_edge_function(text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.call_edge_function(text, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.call_edge_function(text, jsonb)', 'execute') then
    raise exception 'an API role can execute call_edge_function';
  end if;
end $$;
