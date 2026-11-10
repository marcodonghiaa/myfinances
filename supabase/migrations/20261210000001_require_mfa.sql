-- Two-step sign-in (TOTP) is enforced by the database, not only by the dashboard: once a user
-- has a verified authenticator, a session that skipped the code (aal1) sees and changes nothing.
-- Users without an authenticator are unaffected. Pattern from Supabase's MFA guide
-- (restrictive policy on aal), with the factor lookup in one function.
--
-- New tables: add the same restrictive policy (see the loop below) when you enable RLS.
-- Recovery: there are no backup codes. Add a second authenticator in Settings, or the instance
-- owner removes a lost one with: delete from auth.mfa_factors where user_id = '<user id>';

-- True when the caller's session may use their data: they reached aal2, or they have no
-- verified factor. Security definer only to read auth.mfa_factors; it reads the caller's own rows.
create function public.mfa_satisfied()
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

-- One restrictive policy on every RLS table in public: it narrows the existing policies, never
-- widens them. The service role (sync, edge functions) bypasses RLS as before.
do $$
declare
  r record;
begin
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format(
      'create policy "Require two-step sign-in when enabled" on public.%I as restrictive for all to authenticated using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))',
      r.relname);
  end loop;
end;
$$;
