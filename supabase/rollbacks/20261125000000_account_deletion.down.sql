-- Rollback of 20261125000000_account_deletion: drops bank_sessions and puts the cascading keys
-- back to NO ACTION (and drops can_delete_user), except the four that cascaded before (merchant_aliases, holding_trades,
-- user_categories, recurring_streams).
drop table if exists public.bank_sessions;
drop function if exists public.can_delete_user(uuid);
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
      and c.confdeltype = 'c'
      and c.confrelid in ('auth.users'::regclass, 'public.accounts'::regclass,
                          'public.portfolio_holdings'::regclass, 'public.crypto_holdings'::regclass)
      and c.conrelid::regclass::text not in ('merchant_aliases', 'holding_trades',
                                             'user_categories', 'recurring_streams')
  loop
    execute format('alter table %s drop constraint %I', fk.tbl, fk.conname);
    execute format('alter table %s add constraint %I %s', fk.tbl, fk.conname,
                   replace(fk.def, ' ON DELETE CASCADE', ''));
  end loop;
end $$;
