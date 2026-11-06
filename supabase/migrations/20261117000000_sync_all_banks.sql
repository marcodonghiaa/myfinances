-- P2 spike 3: the database fans the bank sync out, one sync-bank call per account, so the sync
-- no longer needs a machine. Every call spends Enable Banking requests (banks allow ~4 unattended
-- a day per account), so this only adds the function: nothing schedules it yet, and it must
-- never run beside the launchd / GitHub Actions sync. Reads two Vault secrets, set once:
--   project_url           https://<project-ref>.supabase.co
--   sync_bank_secret_key  a project secret key (sb_secret_...), sent on the apikey header
create extension if not exists pg_net with schema extensions;
-- A queued request holds the secret key in its headers until pg_net sends it (then the row is
-- deleted). pg_net's tables are granted to PUBLIC by supabase_admin, which a migration can't
-- revoke; they stay out of reach because the net schema is not exposed through the API and
-- anon / authenticated can't log in to the database directly.

-- Returns the pg_net request ids; each response lands in net._http_response (kept ~6 hours).
create or replace function public.sync_all_banks() returns setof bigint
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
  -- pg_net sends these in the background, in parallel. Its default timeout is 5 s; one account's
  -- sync can take up to sync-bank's 150 s wall clock.
  return query
    select net.http_post(
      url := rtrim(base_url, '/') || '/functions/v1/sync-bank',
      body := jsonb_build_object('account_uid', a.uid),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
      timeout_milliseconds := 150000
    )
    from public.accounts a;
end;
$function$;

-- Only the database itself (pg_cron, the SQL editor) may start a run: anon, signed-in users and
-- the API roles must not be able to spend the bank calls. A future drop + create gets Supabase's
-- default grants back, so repeat this revoke there.
revoke execute on function public.sync_all_banks() from public, anon, authenticated, service_role;
