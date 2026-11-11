-- Stops the database from requiring the authenticator code. Run after reverting the Edge Functions
-- (they call mfa_satisfied). Enrolled authenticators stay in auth.mfa_factors.
-- Resets the hook only where it is public.require_mfa (role-wide or this database), so a hook of
-- your own stays. Stops, changing nothing, while a hook of yours still calls require_mfa(): dropping
-- it would make that hook fail on every request.
do $$
declare
  db oid := (select oid from pg_database where datname = current_database());
  chained text;
begin
  select string_agg(distinct h, ', ') into chained
    from (select substr(c, length('pgrst.db_pre_request=') + 1) h
            from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
           where r.rolname = 'authenticator' and s.setdatabase in (0, db)
             and c like 'pgrst.db_pre_request=%') hooks
    join pg_proc p on p.oid = to_regproc(h)
   where h <> 'public.require_mfa' and p.prosrc ilike '%require_mfa%';
  if chained is not null then
    raise exception 'Your pre-request hook % still calls public.require_mfa(): remove that call, then run this again', chained;
  end if;
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
              where r.rolname = 'authenticator' and s.setdatabase = 0
                and 'pgrst.db_pre_request=public.require_mfa' = any (s.setconfig)) then
    alter role authenticator reset pgrst.db_pre_request;
  end if;
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
              where r.rolname = 'authenticator' and s.setdatabase = db
                and 'pgrst.db_pre_request=public.require_mfa' = any (s.setconfig)) then
    execute format('alter role authenticator in database %I reset pgrst.db_pre_request', current_database());
  end if;
end;
$$;
notify pgrst, 'reload config';
drop function if exists public.require_mfa();
drop function if exists public.mfa_satisfied();
