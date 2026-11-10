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

end $$;
