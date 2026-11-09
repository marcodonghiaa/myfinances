-- Deleting a user (Supabase Auth -> Users, or the delete-account Edge Function) failed: 15 of the
-- 19 foreign keys to auth.users, and both to public.accounts, had no ON DELETE, so Postgres
-- refused while any row still pointed at the user. Every such key now cascades: a deleted user
-- takes all their rows with them, and a deleted account its transactions and snapshots.
-- Keys that already have an ON DELETE rule are left as they are.
do $$
declare
  fk record;
begin
  for fk in
    select c.conname, c.conrelid::regclass as tbl, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f'
      and n.nspname = 'public'
      and c.confdeltype = 'a' -- NO ACTION
      and c.confrelid in ('auth.users'::regclass, 'public.accounts'::regclass)
  loop
    execute format('alter table %s drop constraint %I', fk.tbl, fk.conname);
    execute format('alter table %s add constraint %I %s on delete cascade', fk.tbl, fk.conname, fk.def);
  end loop;
end $$;

-- Enable Banking sessions, one per bank link, so they can be closed at Enable Banking when the
-- user deletes their account (and, later, disconnects a bank). Server-only: RLS on and no policy,
-- so the dashboard can neither read nor write it; Edge Functions use the service role.
create table public.bank_sessions (
  session_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  bank_name text,
  created_at timestamptz not null default now()
);
create index bank_sessions_user_id_idx on public.bank_sessions (user_id);
alter table public.bank_sessions enable row level security;
revoke all on table public.bank_sessions from anon, authenticated;
