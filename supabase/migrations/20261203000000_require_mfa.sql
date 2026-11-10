-- Two-step sign-in (TOTP) is enforced by the database, not only by the dashboard: once a user
-- has a verified authenticator, a session that skipped the code (aal1) gets 403 on every Data
-- API request: tables, views and RPCs, security definer ones included, and tables added later.
-- Users without an authenticator are unaffected. Recovery: see UPGRADING.md.
--
-- One PostgREST pre-request hook instead of a policy per table: definer RPCs bypass RLS, so a
-- policy alone would leave them open. The hook covers the Data API only (not Realtime or
-- Storage, which this app does not use).

-- True when the caller's session may use their data: they reached aal2, or they have no
-- verified factor. Security definer only to read auth.mfa_factors; it reads the caller's own rows.
-- No user (anon, service role) means no factor, so true.
create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = (select auth.uid()) and f.status = 'verified'
      );
$$;
revoke execute on function public.mfa_satisfied() from public, anon;
grant execute on function public.mfa_satisfied() to authenticated;

-- Runs before every Data API request, as the request's role.
create or replace function public.require_mfa()
returns void
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  if not public.mfa_satisfied() then
    raise exception 'Enter your authenticator code first'
      using errcode = 'insufficient_privilege', hint = 'mfa_required';
  end if;
end;
$$;
revoke execute on function public.require_mfa() from public;
grant execute on function public.require_mfa() to anon, authenticated, service_role;

-- Refuse to replace a hook the instance already has (see UPGRADING.md to chain it).
do $$
declare
  existing text;
begin
  -- Role-wide and this-database settings both count: a per-database one wins at runtime.
  select string_agg(distinct substr(c, length('pgrst.db_pre_request=') + 1), ', ') into existing
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
   where r.rolname = 'authenticator'
     and s.setdatabase in (0, (select oid from pg_database where datname = current_database()))
     and c like 'pgrst.db_pre_request=%'
     and c <> 'pgrst.db_pre_request=public.require_mfa';
  if existing is not null then
    raise exception 'PostgREST already runs pre-request hook %; call public.require_mfa() from it instead', existing;
  end if;
end;
$$;
alter role authenticator set pgrst.db_pre_request to 'public.require_mfa';
notify pgrst, 'reload config';
