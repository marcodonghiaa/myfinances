-- Manual accounts (transactions typed in by hand, add_manual_transaction) have no bank behind
-- them: the fan-out sent them to sync-bank anyway, which spent Enable Banking calls on an id the
-- bank never issued and logged a 502 every run. Same function as 20261117000000, bank accounts only.
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
  return query
    select net.http_post(
      url := rtrim(base_url, '/') || '/functions/v1/sync-bank',
      body := jsonb_build_object('account_uid', a.uid),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
      timeout_milliseconds := 150000
    )
    from public.accounts a
    where not a.manual;
end;
$function$;

-- create or replace keeps the grants, but repeat the revoke so this file is safe on its own.
revoke execute on function public.sync_all_banks() from public, anon, authenticated, service_role;
