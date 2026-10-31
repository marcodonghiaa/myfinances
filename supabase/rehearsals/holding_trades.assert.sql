-- Asserts for 20261108000000 (local only). Runs in one rolled-back transaction, from the repo root:
--   M=supabase/migrations/20261107000000_price_history_and_holding_performance.sql
--   T=supabase/migrations/20261108000000_holding_trades.sql
--   ( echo 'begin;'; cat $M $T supabase/rehearsals/holding_trades.assert.sql \
--       supabase/rollbacks/20261108000000_holding_trades.down.sql; \
--     echo "select to_regclass('public.holding_trades') is null as dropped;"; cat $T; echo 'rollback;' ) \
--     | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback must work, and the migration must apply again on top.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'b1@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'b2@example.test');
insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label) values
  ('00000000-0000-0000-0000-0000000000b1', 'US00000000A1', 'HLD', 'Held', 2, 'T'),
  ('00000000-0000-0000-0000-0000000000b1', 'US00000000A2', 'SLD', 'Sold, has trades', 0, 'T'),
  ('00000000-0000-0000-0000-0000000000b1', 'US00000000A3', 'NOT', 'Sold, no trades', 0, 'T');
insert into public.crypto_holdings (user_id, asset_symbol, name, amount, source, coingecko_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'SOL', 'Sold coin', 0, 'Ledger', 'solana'),
  ('00000000-0000-0000-0000-0000000000b1', 'XXX', 'Sold coin no trades', 0, 'Ledger', 'xxx');
insert into public.price_history (provider, symbol, price_date, price, currency) values
  ('yahoo', 'SLD', '2026-09-01', 10, 'EUR'), ('yahoo', 'SLD', '2026-10-01', 12, 'EUR'),
  ('yahoo', 'HLD', '2026-09-01', 10, 'EUR'), ('yahoo', 'HLD', '2026-10-01', 11, 'EUR');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur, fee_eur) values
  ('00000000-0000-0000-0000-0000000000b1', 'stock', 'US00000000A1', 'buy', '2026-08-01', 2, 9, 1),
  ('00000000-0000-0000-0000-0000000000b1', 'stock', 'US00000000A2', 'buy', '2026-08-01', 1, 9, 0),
  ('00000000-0000-0000-0000-0000000000b1', 'stock', 'US00000000A2', 'sell', '2026-09-15', 1, 11, 0),
  ('00000000-0000-0000-0000-0000000000b1', 'crypto', 'SOL', 'buy', '2026-08-01', 1, 100, 0);

do $$
declare
  n int;
begin
  -- sold with trades comes back at quantity 0 with its price; sold without trades does not
  select count(*) into n from public.holding_performance('2026-09-02');
  assert n = 3, 'want held + sold stock with trades + sold coin with trades, got ' || n;
  assert (select quantity from public.holding_performance('2026-09-02') where key = 'US00000000A2') = 0, 'sold quantity';
  assert (select start_price_eur from public.holding_performance('2026-09-02') where key = 'US00000000A2') = 10, 'sold start price';
  assert not exists (select 1 from public.holding_performance('2026-09-02') where key in ('US00000000A3', 'XXX')), 'no trades stays out';
  assert (select quantity from public.holding_performance('2026-09-02') where key = 'SOL') = 0, 'sold coin';

  -- invalid values are refused
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur)
      values ('00000000-0000-0000-0000-0000000000b1', 'stock', 'K', 'buy', '2026-08-01', 0, 1);
    assert false, 'zero shares accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur)
      values ('00000000-0000-0000-0000-0000000000b1', 'stock', 'K', 'gift', '2026-08-01', 1, 1);
    assert false, 'bad side accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur)
      values ('00000000-0000-0000-0000-0000000000b1', 'stock', 'K', 'buy', '2026-08-01', 1, -1);
    assert false, 'negative price accepted';
  exception when check_violation then null;
  end;
  -- not as someone else
  begin
    insert into public.holding_trades (user_id, kind, key, side, trade_date, shares, price_eur)
      values ('00000000-0000-0000-0000-0000000000b2', 'stock', 'K', 'buy', '2026-08-01', 1, 1);
    assert false, 'wrote a trade for another user';
  exception when insufficient_privilege then null;
  end;
end $$;

-- the second user sees and changes nothing of the first's
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
do $$
declare
  n int;
begin
  select count(*) into n from public.holding_trades;
  assert n = 0, 'second user can read trades';
  update public.holding_trades set shares = 99;
  delete from public.holding_trades;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
do $$
begin
  assert (select count(*) from public.holding_trades) = 4, 'second user changed trades';
  assert not exists (select 1 from public.holding_trades where shares = 99), 'second user updated trades';
end $$;

-- anon has no way in
reset role;
set local role anon;
do $$
begin
  perform 1 from public.holding_trades;
  assert false, 'anon can read trades';
exception when insufficient_privilege then null;
end $$;
reset role;
