-- P2 switch-over: pg_cron runs the whole sync inside Supabase, so no machine has to stay on.
-- APPLY ONLY TOGETHER WITH STOPPING THE OTHER SCHEDULER (launchd / Docker scheduler.js /
-- GitHub Actions sync.yml): two schedulers double the bank calls, and banks allow about 4
-- unattended calls a day per account. Needs the Vault secrets project_url and
-- sync_bank_secret_key (see 20261117000000_sync_all_banks.sql) and the Edge Functions
-- sync-bank, post-sync, sync-prices and notify merged and deployed first (each with
-- verify_jwt = false): a job calling a missing function fails without a sign. Times are UTC.
-- A job only queues its request, so cron.job_run_details says "succeeded" even when the function
-- answers with an error. Look at the answers (kept ~6 hours):
--   select id, status_code, timed_out, created from net._http_response
--    where status_code >= 400 or timed_out or error_msg is not null order by created desc;
create extension if not exists pg_cron;

-- One call to an Edge Function, with the same Vault URL and secret key as sync_all_banks.
-- Returns the pg_net request id; the answer lands in net._http_response (kept ~6 hours).
create or replace function public.call_edge_function(function_name text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  base_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'sync_bank_secret_key');
begin
  if base_url is null or secret_key is null then
    raise exception 'Set the Vault secrets project_url and sync_bank_secret_key first';
  end if;
  if function_name !~ '^[a-z0-9-]+$' then
    raise exception 'Not an Edge Function name: %', function_name;
  end if;
  return net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/' || function_name,
    body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
    timeout_milliseconds := 150000
  );
end;
$function$;

-- Only the database itself may call it: it carries the secret key.
revoke execute on function public.call_edge_function(text, jsonb) from public, anon, authenticated, service_role;

-- Same rhythm as sync.yml. cron.schedule replaces a job of the same name, so re-running is safe.
-- Banks every 6 h (4 a day), one sync-bank call per account in parallel.
select cron.schedule('sync-banks', '17 */6 * * *', 'select public.sync_all_banks()');
-- 15 minutes later, when every account's sync has answered: categories, types, Splitwise, flow.
select cron.schedule('post-sync', '32 */6 * * *', $$select public.call_edge_function('post-sync')$$);
-- Exchange rates and holding prices (no bank calls).
select cron.schedule('sync-prices', '37 */6 * * *', $$select public.call_edge_function('sync-prices')$$);
-- "Worth it?" prompts hourly; bank-access reminders once a day.
select cron.schedule('notify-worth-it', '42 * * * *', $$select public.call_edge_function('notify', '{"job":"worth-it"}')$$);
select cron.schedule('notify-consent', '3 8 * * *', $$select public.call_edge_function('notify', '{"job":"consent"}')$$);
