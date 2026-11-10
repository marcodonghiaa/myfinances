-- Rollback of 20261201000000_holding_trades_external_id. The broker ids stored since are lost;
-- the trades themselves stay.
drop index if exists public.holding_trades_external;
alter table public.holding_trades
  drop constraint if exists holding_trades_external_needs_source,
  drop column if exists external_id,
  drop column if exists source;
