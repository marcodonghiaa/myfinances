-- Seed for the 20261107000000 rehearsal (local only, never the linked project). Needs the auth schema:
-- a Supabase local stack. Run migration, seed and assert in ONE transaction that you roll back; see
-- the header of holding_performance.assert.sql. Dates are fixed so the cases never drift.
insert into auth.users (id, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', now()),
  ('00000000-0000-0000-0000-0000000000a2', now());

insert into public.fx_rates (date, currency, rate_to_eur) values
  ('2026-09-01', 'USD', 0.88), ('2026-09-25', 'USD', 0.90), ('2026-10-30', 'USD', 1.00),
  ('2026-09-25', 'GBP', 1.20);

-- shares: AAA 10, BBB 2, CCC 5, DDD 1, EEE 1, FFF 1, GGG 1, HHH 4, III 0 (sold), LLL 3
insert into public.portfolio_holdings (user_id, isin, yahoo_symbol, name, shares, broker_label, asset_type) values
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000001', 'AAA', 'Hole filled', 10, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000002', 'BBB', 'Hole not filled', 2, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000003', 'CCC', 'Weekend carry', 5, 'T', 'ETF'),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000004', 'DDD', 'Young', 1, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000005', 'EEE', 'Added today', 1, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000006', 'FFF', 'Never priced', 1, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'CH0000000007', 'GGG', 'No fx', 1, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'GB0000000008', 'HHH', 'Pounds', 4, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000009', 'III', 'Sold', 0, 'T', 'Stock'),
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000010', 'LLL', 'Weekend repeat', 3, 'T', 'ETF'),
  ('00000000-0000-0000-0000-0000000000a2', 'US0000000001', 'AAA', 'Other user', 99, 'T', 'Stock');

insert into public.portfolio_snapshots (user_id, isin, snapshot_date, price, currency, value_native, value_eur) values
  -- AAA: snapshots only after the hole; history fills 2026-09-30; both on 10-06 (snapshot must win)
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000001', '2026-10-06', 100, 'USD', 1000, 900),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000001', '2026-10-30', 120, 'USD', 1200, 1200),
  -- BBB: same hole, no history
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000002', '2026-09-17', 50, 'USD', 100, 90),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000002', '2026-10-30', 60, 'USD', 120, 120),
  -- CCC: Friday and a later price, EUR (no fx rows needed)
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000003', '2026-10-23', 10, 'EUR', 50, 50),
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000003', '2026-10-30', 11, 'EUR', 55, 55),
  -- DDD: first priced after the range start
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000004', '2026-10-28', 10, 'USD', 10, 9),
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000004', '2026-10-30', 11, 'USD', 11, 11),
  -- EEE: a single price, today
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000005', '2026-10-30', 7, 'USD', 7, 7),
  -- GGG: CHF with no CHF rate
  ('00000000-0000-0000-0000-0000000000a1', 'CH0000000007', '2026-09-30', 20, 'CHF', 20, null),
  ('00000000-0000-0000-0000-0000000000a1', 'CH0000000007', '2026-10-30', 22, 'CHF', 22, null),
  -- HHH: GBP
  ('00000000-0000-0000-0000-0000000000a1', 'GB0000000008', '2026-09-30', 2, 'GBP', 8, 9.6),
  ('00000000-0000-0000-0000-0000000000a1', 'GB0000000008', '2026-10-30', 3, 'GBP', 12, 14.4),
  -- III: sold, still has snapshots
  ('00000000-0000-0000-0000-0000000000a1', 'US0000000009', '2026-10-30', 5, 'USD', 0, 0),
  -- LLL: Friday close repeated on Saturday and Sunday (what Yahoo gives on a weekend)
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000010', '2026-10-22', 9, 'EUR', 27, 27),
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000010', '2026-10-23', 10, 'EUR', 30, 30),
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000010', '2026-10-24', 10, 'EUR', 30, 30),
  ('00000000-0000-0000-0000-0000000000a1', 'IE0000000010', '2026-10-25', 10, 'EUR', 30, 30),
  -- the other user
  ('00000000-0000-0000-0000-0000000000a2', 'US0000000001', '2026-10-30', 500, 'USD', 49500, 49500);

insert into public.price_history (provider, symbol, price_date, price, currency) values
  ('yahoo', 'AAA', '2026-09-30', 90, 'USD'),
  ('yahoo', 'AAA', '2026-10-06', 999, 'USD'),
  ('coingecko', 'bitcoin', '2026-10-29', 90, 'USD');

-- BTC held in two places: one row, amounts summed
insert into public.crypto_holdings (user_id, asset_symbol, name, amount, source, coingecko_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'BTC', 'Bitcoin', 1, 'Ledger', 'bitcoin'),
  ('00000000-0000-0000-0000-0000000000a1', 'BTC', 'Bitcoin', 0.5, 'Coinbase', 'bitcoin');
insert into public.crypto_snapshots (user_id, asset_symbol, source, snapshot_date, amount, price_usd, value_usd, value_eur) values
  ('00000000-0000-0000-0000-0000000000a1', 'BTC', 'Ledger', '2026-09-30', 1, 50, 50, 45),
  ('00000000-0000-0000-0000-0000000000a1', 'BTC', 'Coinbase', '2026-09-30', 0.5, 50, 25, 22.5),
  ('00000000-0000-0000-0000-0000000000a1', 'BTC', 'Ledger', '2026-10-30', 1, 100, 100, 100),
  ('00000000-0000-0000-0000-0000000000a1', 'BTC', 'Coinbase', '2026-10-30', 0.5, 100, 50, 50);
