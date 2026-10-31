-- Runs between the rollback file and a second apply of 20261107000000 (see holding_performance.assert.sql).
do $$
begin
  assert to_regclass('public.price_history') is null, 'down left price_history';
  assert not exists (select 1 from pg_proc where proname = 'holding_performance'), 'down left the function';
end $$;
