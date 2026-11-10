-- Rollback of 20261128000000_transfer_detection. Flows already set (transfers paired or found by
-- own account) stay as they are; only who decided them and the pairs are dropped.
drop function if exists public.resolve_transfer_pair(uuid, boolean);
drop table if exists public.transfer_pairs;
drop trigger if exists trg_flow_source_user on public.transactions;
drop function if exists public.flow_source_user();
alter table public.category_rules drop column if exists set_flow_type;
alter table public.transactions drop column if exists own_counterparty, drop column if exists flow_source;
