-- With supabase-shim.sql, enough of Supabase to apply every migration in order on plain Postgres
-- (no pg_net or pg_cron: tests strip those two `create extension` lines and use the stubs below).
-- Lets a test run on the real schema, with its triggers and views, instead of a hand-made copy.
do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login; end if;
  if not exists (select from pg_roles where rolname = 'supabase_admin') then create role supabase_admin; end if;
end $$;
alter table auth.users add column created_at timestamptz default now(), add column email text;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', current_user)
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}')
$$;
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text, factor_type text);
create schema extensions;
create schema vault;
create view vault.decrypted_secrets as select ''::text as name, ''::text as decrypted_secret;
create schema cron;
create table cron.job (jobid bigint, jobname text);
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
create function cron.unschedule(text) returns boolean language sql as $$ select true $$;
create schema net;
create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 0)
  returns bigint language sql as $$ select 1::bigint $$;
