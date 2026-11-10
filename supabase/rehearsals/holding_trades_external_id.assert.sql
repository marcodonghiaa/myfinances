-- Asserts for 20261201000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   T=supabase/migrations/20261201000000_holding_trades_external_id.sql
--   ( echo 'begin;'; cat $T supabase/rehearsals/holding_trades_external_id.assert.sql \
--       supabase/rollbacks/20261201000000_holding_trades_external_id.down.sql; cat $T; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback must work, and the migration must apply again on top.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'c1@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'c2@example.test');

do $$
declare
  u1 uuid := '00000000-0000-0000-0000-0000000000c1';
  u2 uuid := '00000000-0000-0000-0000-0000000000c2';
begin
  -- two identical buys on one day, each with its own broker id: both are kept
  insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, source, external_id) values
    (u1, 'stock', 'K', 'buy', '2026-10-01', 1, 10, 'trade_republic', 'a'),
    (u1, 'stock', 'K', 'buy', '2026-10-01', 1, 10, 'trade_republic', 'b');
  -- rows without an id (typed in, plain CSV) are never constrained
  insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur) values
    (u1, 'stock', 'K', 'buy', '2026-10-01', 1, 10), (u1, 'stock', 'K', 'buy', '2026-10-01', 1, 10);
  -- the same id is fine for another user or another broker
  insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, source, external_id) values
    (u2, 'stock', 'K', 'buy', '2026-10-01', 1, 10, 'trade_republic', 'a'),
    (u1, 'stock', 'K', 'buy', '2026-10-01', 1, 10, 'degiro', 'a');

  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, source, external_id)
      values (u1, 'stock', 'K', 'buy', '2026-10-02', 1, 10, 'trade_republic', 'a');
    raise exception 'a re-imported broker id must be refused';
  exception when unique_violation then null;
  end;
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, external_id)
      values (u1, 'stock', 'K', 'buy', '2026-10-02', 1, 10, 'x');
    raise exception 'an id without a source must be refused';
  exception when check_violation then null;
  end;
end $$;
