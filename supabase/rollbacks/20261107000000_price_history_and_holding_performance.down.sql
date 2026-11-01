-- Drops the function first, then the table. The backfilled prices in price_history are lost, and
-- nothing fills them again: total return needs only the latest price.
drop function if exists public.holding_performance(date, boolean);
drop table if exists public.price_history;
