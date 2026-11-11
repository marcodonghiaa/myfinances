-- Asserts for 20261204000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   T=supabase/migrations/20261204000000_manual_transaction_checks.sql
--   ( echo 'begin;'; cat $T supabase/rehearsals/manual_transaction_checks.assert.sql \
--       supabase/rollbacks/20261204000000_manual_transaction_checks.down.sql; cat $T; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback must work, and the migration must apply again on top.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'd1@example.test');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);

do $$
declare
  bad record;
begin
  -- a normal row still goes in, with the currency upper-cased
  perform public.add_manual_transaction('2026-03-01', 'Coffee', 3.2, 'DBIT', 'dkk', null, 'Bank');
  if not exists (select 1 from public.transactions where creditor_name = 'Coffee' and currency = 'DKK') then
    raise exception 'a normal row must be saved';
  end if;

  for bad in
    select * from (values
      ('NaN'::numeric, 'EUR', 'x', 'Bank', 'NaN amount'),
      (1e13, 'EUR', 'x', 'Bank', 'amount above a trillion'),
      (1, 'EURO', 'x', 'Bank', 'currency that is not 3 letters'),
      (1, 'EUR', repeat('x', 501), 'Bank', 'description over 500 characters'),
      (1, 'EUR', 'x', repeat('s', 61), 'source over 60 characters')
    ) v(amount, currency, description, source, what)
  loop
    begin
      perform public.add_manual_transaction('2026-03-01', bad.description, bad.amount, 'DBIT', bad.currency, null, bad.source);
      raise exception 'must refuse a %', bad.what using errcode = 'P0002';
    exception when raise_exception then null;
    end;
  end loop;

  -- polish-5 #8: a manual account named before the 60-character limit still takes new rows
  insert into public.accounts (uid, user_id, currency, label, bank_name, manual)
  values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000d1', 'EUR', repeat('L', 80), repeat('L', 80), true);
  perform public.add_manual_transaction('2026-03-01', 'Old source', 1, 'DBIT', 'EUR', null, repeat('L', 80));
  if (select count(*) from public.accounts
      where user_id = '00000000-0000-0000-0000-0000000000d1' and label = repeat('L', 80)) <> 1 then
    raise exception 'an existing long-named account must be reused';
  end if;
  -- polish-5 #8: the category has a limit too (100, as Splitwise categories)
  begin
    perform public.add_manual_transaction('2026-03-01', 'x', 1, 'DBIT', 'EUR', repeat('c', 101), 'Bank');
    raise exception 'must refuse a category over 100 characters' using errcode = 'P0002';
  exception when raise_exception then null;
  end;

  -- polish-5 #3: a missing direction is refused, not saved as income
  begin
    perform public.add_manual_transaction('2026-03-01', 'x', 1, null, 'EUR', null, 'Bank');
    raise exception 'must refuse a missing direction' using errcode = 'P0002';
  exception when raise_exception then null;
  end;

end $$;
