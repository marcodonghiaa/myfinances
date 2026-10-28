-- Roll back the functions and the dashboard first: they read this table and column.
-- Origins registered so far are lost; the dashboard registers again on the next sign-in after a re-apply.
begin;
drop function if exists public.register_dashboard_origin();
drop table if exists public.dashboard_origins;
alter table public.pending_bank_consents drop column if exists origin;
commit;
