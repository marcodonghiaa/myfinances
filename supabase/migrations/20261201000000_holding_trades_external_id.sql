-- Broker imports remember where each trade came from and the broker's own id for it, so a
-- re-import is skipped by id and two identical buys on the same day stay two trades.
-- Both columns are optional: trades typed in or imported from a plain CSV have neither.
-- Adding nullable columns is metadata only; the table holds one row per trade, so the index builds
-- in a blink and doesn't need CONCURRENTLY (which can't run inside the migration's transaction).
set local lock_timeout = '5s';

alter table public.holding_trades
  add column source text check (source is null or char_length(source) between 1 and 40),
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 200),
  add constraint holding_trades_external_needs_source check (external_id is null or source is not null);

-- One row per broker trade and user. Partial: rows without an id are not constrained.
create unique index holding_trades_external
  on public.holding_trades (user_id, source, external_id)
  where external_id is not null;
