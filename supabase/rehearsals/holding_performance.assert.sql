-- Asserts for 20261107000000 (local only, as a superuser). Everything runs in one transaction that is
-- rolled back, so the local database is left as it was. From the repo root, with the local stack up:
--   M=supabase/migrations/20261107000000_price_history_and_holding_performance.sql
--   ( echo 'begin;'; cat $M supabase/rehearsals/holding_performance.seed.sql \
--       supabase/rehearsals/holding_performance.assert.sql \
--       supabase/rollbacks/20261107000000_price_history_and_holding_performance.down.sql \
--       supabase/rehearsals/holding_performance.after_down.assert.sql $M; \
--     echo 'rollback;' ) | docker exec -i supabase_db_finance_app psql -U postgres -v ON_ERROR_STOP=1
-- Success prints no error. The rollback file is rehearsed too: it must remove both objects, and the
-- migration must apply again on top.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
-- fx_rates' policy checks auth.role(), which reads this claim: without it the signed-in path differs
select set_config('request.jwt.claim.role', 'authenticated', true);

create temp table m1 as select * from public.holding_performance('2026-09-30');
create temp table wk as select * from public.holding_performance('2026-10-25');
create temp table lm as select * from public.holding_performance('2026-09-30', true);

-- the same call as a signed-in user (RLS on holdings, snapshots, fx_rates, price_history) must be identical
create temp table m1_user as select * from m1 limit 0;
grant all on m1_user to authenticated;
set local role authenticated;
insert into m1_user select * from public.holding_performance('2026-09-30');
reset role;
do $$
begin
  assert (select count(*) from m1) = (select count(*) from m1_user), 'signed-in user gets a different row count';
  assert not exists (select * from m1 except select * from m1_user), 'signed-in user gets different rows (RLS or grants)';
  assert not exists (select * from m1_user except select * from m1), 'signed-in user gets different rows (RLS or grants)';
end $$;

do $$
declare r record;
begin
  -- who is returned
  assert (select count(*) from m1) = 14, 'want 13 stocks (sold one excluded) + 1 coin, got ' || (select count(*) from m1);
  assert not exists (select 1 from m1 where key = 'US0000000009'), 'sold holding returned';
  assert (select count(*) from m1 where kind = 'crypto') = 1, 'BTC from two sources not one row';
  assert (select quantity from m1 where key = 'BTC') = 1.5, 'BTC quantities not summed';

  -- AAA: 09-30 comes from history (hole filled), end is the snapshot; fx of the price date
  select * into r from m1 where key = 'US0000000001';
  assert r.status = 'ok' and r.start_date = '2026-09-30', 'AAA start not the history price: ' || r::text;
  assert r.start_price_eur = 81 and r.end_price_eur = 120, 'AAA EUR prices wrong: ' || r::text;

  -- same-day collision: snapshot (100) beats history (999) on 10-06
  select * into r from public.holding_performance('2026-10-06') where key = 'US0000000001';
  assert r.start_date = '2026-10-06' and r.start_price_eur = 100 * 0.90, 'history beat the snapshot: ' || r::text;

  -- BBB: nearest price is 13 days before the start, no history: stale, not a made-up return
  assert (select status from m1 where key = 'US0000000002') = 'stale', 'hole without history not stale';
  assert (select start_date from m1 where key = 'US0000000002') = '2026-09-17', 'BBB start date';

  -- CCC: Sunday start carries Friday; EUR needs no fx row
  select * into r from wk where key = 'IE0000000003';
  assert r.status = 'ok' and r.start_date = '2026-10-23' and r.start_price_eur = 10 and r.end_price_eur = 11,
    'weekend carry wrong: ' || r::text;

  -- 7 days before the start is still ok, 8 is a hole
  assert (select status from m1 where key = 'US0000000011') = 'ok', 'seven days not ok';
  assert (select status from m1 where key = 'US0000000012') = 'stale', 'eight days not stale';

  -- history only, no snapshot: still priced
  select * into r from m1 where key = 'US0000000013';
  assert r.status = 'ok' and r.start_price_eur = 20 and r.end_price_eur = 25, 'history-only holding: ' || r::text;

  -- a price that stopped updating (latest 10 days older than the rest) is not used
  assert (select status from m1 where key = 'US0000000014') = 'stale', 'stopped-updating price not stale';

  -- DDD first priced after the range start
  select * into r from m1 where key = 'US0000000004';
  assert r.status = 'since' and r.start_date = '2026-10-28', 'young holding: ' || r::text;

  -- EEE one price: zero length
  select * into r from m1 where key = 'US0000000005';
  assert r.status = 'since' and r.start_date = r.end_date, 'single price not zero length: ' || r::text;

  -- FFF no price at all
  select * into r from m1 where key = 'US0000000006';
  assert r.status = 'no_price' and r.start_price_eur is null and r.end_price_eur is null and r.end_date is null,
    'unpriced holding: ' || r::text;

  -- GGG currency without a rate: row stays, no number
  select * into r from m1 where key = 'CH0000000007';
  assert r.status = 'no_price' and r.start_price_eur is null, 'missing fx not no_price: ' || r::text;

  -- HHH pounds at the GBP rate of that date
  select * into r from m1 where key = 'GB0000000008';
  assert r.start_price_eur = 2 * 1.2 and r.end_price_eur = 3 * 1.2 and r.status = 'ok', 'GBP wrong: ' || r::text;

  -- BTC: price in USD x fx; start 50 x 0.90, end 100 x 1.00
  select * into r from m1 where key = 'BTC';
  assert r.start_price_eur = 45 and r.end_price_eur = 100 and r.status = 'ok', 'BTC wrong: ' || r::text;

  -- last move: LLL ends 10-30 at 10; 10-28 and 10-29 also 10, so the start is 10-27 at 9
  select * into r from lm where key = 'IE0000000010';
  assert r.status = 'ok' and r.start_date = '2026-10-27' and r.start_price_eur = 9 and r.end_price_eur = 10,
    'last move not the last different price: ' || r::text;
  -- BTC last move: 10-29 history price 90 USD (x 0.90) differs from 100
  select * into r from lm where key = 'BTC';
  assert r.start_date = '2026-10-29' and r.start_price_eur = 90 * 0.90, 'BTC last move: ' || r::text;
  -- a holding with only one price has no earlier price: zero length
  select * into r from lm where key = 'US0000000005';
  assert r.status = 'since' and r.start_date = r.end_date, 'last move single price: ' || r::text;

  -- p_from after the last price: zero length, not an error
  select * into r from public.holding_performance('2027-01-01') where key = 'US0000000001';
  assert r.start_date = r.end_date and r.status = 'ok', 'future p_from: ' || r::text;

  -- null p_from is refused
  begin
    perform public.holding_performance(null);
    assert false, 'null p_from accepted';
  exception when sqlstate '22004' then null;
  end;

  -- privileges
  assert not has_function_privilege('anon', 'public.holding_performance(date, boolean)', 'execute'), 'anon can execute';
  assert has_function_privilege('authenticated', 'public.holding_performance(date, boolean)', 'execute'), 'authenticated cannot execute';
  assert not has_table_privilege('anon', 'public.price_history', 'select'), 'anon can read price_history';
  assert has_table_privilege('authenticated', 'public.price_history', 'select'), 'authenticated cannot read price_history';
  assert not has_table_privilege('authenticated', 'public.price_history', 'insert'), 'authenticated can write price_history';
end $$;

-- another signed-in user sees only their own holdings (and none of user 1's)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
set local role authenticated;
do $$
begin
  assert (select count(*) from public.holding_performance('2026-09-30')) = 1, 'second user sees other rows';
  assert (select quantity from public.holding_performance('2026-09-30')) = 99, 'second user sees wrong holding';
end $$;
reset role;

-- no session: nothing
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  assert (select count(*) from public.holding_performance('2026-09-30')) = 0, 'no session returned rows';
end $$;

-- the net worth views never read price_history
do $$
begin
  assert not exists (
    select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class
    where d.refobjid = 'public.price_history'::regclass and v.relkind = 'v'
  ), 'a view depends on price_history';
end $$;
