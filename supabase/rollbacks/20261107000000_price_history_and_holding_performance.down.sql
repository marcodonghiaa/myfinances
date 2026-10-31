-- Drops the function first, then the table. The backfilled prices in price_history are lost;
-- backfill-price-history.js (or the next sync) fills them again.
drop function if exists public.holding_performance(date, boolean);
drop table if exists public.price_history;
