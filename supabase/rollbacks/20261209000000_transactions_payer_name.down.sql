-- Rollback of 20261209000000_transactions_payer_name.
-- Nothing to run. The migration only adds payer_name as the last column of v_transactions_eur.
-- It is read-only, and an older dashboard never asks for it, so leaving it in place is safe.
-- Postgres can't remove a view column with create or replace; removing it would mean dropping
-- and recreating every view built on v_transactions_eur, which is riskier than the column.
-- To roll back: redeploy the previous dashboard, then mark the migration reverted:
--   supabase migration repair --status reverted 20261209000000 --linked
-- (Re-applying it later is safe: create or replace with the same column list.)
select 1;
