-- Stops the database from requiring the authenticator code. Run after reverting the Edge Functions
-- (they call mfa_satisfied). Enrolled authenticators stay in auth.mfa_factors.
do $$
declare
  r record;
begin
  for r in
    select tablename from pg_policies
     where schemaname = 'public' and policyname = 'Require two-step sign-in when enabled'
  loop
    execute format('drop policy "Require two-step sign-in when enabled" on public.%I', r.tablename);
  end loop;
end;
$$;
drop function if exists public.mfa_satisfied();
