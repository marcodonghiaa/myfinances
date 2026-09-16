-- Perf: fx_rates is read via "where currency = X and date <= Y order by date
-- desc limit 1" from every net-worth/spend view, but its PK is (date,
-- currency) -- wrong leading column for that access pattern.
create index idx_fx_rates_currency_date on public.fx_rates (currency, date desc);

-- Perf: net_worth_snapshots.account_uid is an FK joined directly in
-- v_bank_accounts_latest but had no index.
create index idx_net_worth_snapshots_account_uid on public.net_worth_snapshots (account_uid);

-- Correctness: nothing constrained personal_amount (the expense-splitting
-- "my share" figure) to be a valid magnitude of amount -- a client bug could
-- set it negative or larger than the transaction itself, silently corrupting
-- v_spend_by_category_monthly / v_income_vs_expenses_monthly totals.
alter table public.transactions
  add constraint personal_amount_within_amount
  check (personal_amount is null or (personal_amount >= 0 and personal_amount <= amount));
