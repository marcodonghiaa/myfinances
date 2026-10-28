-- Local rehearsal of 20261106000000 (needs the auth schema: a Supabase local stack, or a scratch Postgres with
-- auth.users, auth.uid() and the anon/authenticated roles). Run after applying the migration, as a superuser.
-- The origin cases mirror dashboard-origins.cases.json; frontend-url.test.js checks they stay in sync.
begin;
insert into auth.users (id, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000a2', now());
delete from public.dashboard_origins;

create function pg_temp.reg(who uuid, origin text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.headers', case when origin is null then '{}' else json_build_object('origin', origin)::text end, true);
  return public.register_dashboard_origin();
end $$;

do $$
declare
  owner_id uuid := '00000000-0000-0000-0000-0000000000a1';
begin
  assert pg_temp.reg(owner_id, 'https://my-finances.vercel.app') = 'added', 'owner https not added';
  assert pg_temp.reg(owner_id, 'https://my-finances.vercel.app') = 'exists', 'repeat not idempotent';
  assert pg_temp.reg(owner_id, 'HTTPS://Finances.Example.com') = 'added', 'origin not lowercased';
  assert pg_temp.reg(owner_id, 'https://finances.example.com') = 'exists', 'lowercase form not the stored one';
  assert pg_temp.reg(owner_id, 'http://localhost:3000') = 'added', 'localhost with port refused';
  assert pg_temp.reg(owner_id, 'http://localhost') = 'rejected', 'localhost without port accepted';
  assert pg_temp.reg(owner_id, 'http://my-finances.vercel.app') = 'rejected', 'plain http accepted';
  assert pg_temp.reg(owner_id, 'https://my-finances-abc123xyz-marco.vercel.app') = 'rejected', 'vercel deployment host accepted';
  assert pg_temp.reg(owner_id, 'https://my-finances-git-main-marco.vercel.app') = 'rejected', 'vercel branch host accepted';
  assert pg_temp.reg(owner_id, 'not an origin') = 'rejected', 'garbage accepted';
  assert pg_temp.reg(owner_id, null) = 'no_origin', 'missing Origin header not a no-op';
  assert pg_temp.reg('00000000-0000-0000-0000-0000000000a2', 'https://evil.example.com') = 'not_owner', 'second user registered';
  assert pg_temp.reg(null, 'https://evil.example.com') = 'not_owner', 'no session registered';
  assert pg_temp.reg(owner_id, 'http://localhost:8080') = 'added', 'fourth origin refused';
  assert pg_temp.reg(owner_id, 'https://b.example.com') = 'added', 'fifth origin refused';
  assert pg_temp.reg(owner_id, 'https://c.example.com') = 'full', 'cap of 5 not enforced';
  assert (select count(*) from public.dashboard_origins) = 5, 'wrong row count';
  assert not has_function_privilege('anon', 'public.register_dashboard_origin()', 'execute'), 'anon can execute';
  assert has_function_privilege('authenticated', 'public.register_dashboard_origin()', 'execute'), 'authenticated cannot execute';
  assert not has_table_privilege('authenticated', 'public.dashboard_origins', 'select'), 'table readable by users';
end $$;
rollback;
