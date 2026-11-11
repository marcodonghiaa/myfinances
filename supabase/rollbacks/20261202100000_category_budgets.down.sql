-- Rollback of 20261202100000_category_budgets. Every budget set since is lost.
drop table if exists public.category_budgets;
