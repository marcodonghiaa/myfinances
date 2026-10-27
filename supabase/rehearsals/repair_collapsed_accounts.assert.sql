-- Asserts for the 20261103000000 repair rehearsal (local only). Run after supabase/rehearsals/repair_collapsed_accounts.seed.sql.
do $$ begin
  assert (select currency = 'EUR' and identification_hash is null from public.accounts
          where uid = '00000000-0000-0000-0000-0000000000b1'),
    'collapsed account not repaired (want EUR, null hash)';
  assert (select currency = 'EUR' and identification_hash = 'h-ok' from public.accounts
          where uid = '00000000-0000-0000-0000-0000000000b2'),
    'normal account changed';
  assert exists (select 1 from pg_indexes where indexname = 'accounts_user_identification_hash_key'),
    'unique index accounts_user_identification_hash_key missing';
end $$;
