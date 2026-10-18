-- Month-end net worth from before live snapshots existed (imported via net-worth-history.js).
-- Kept apart from net_worth_snapshots on purpose: those rows are per bank account and feed the
-- carry-forward in v_net_worth_daily, which hand-entered history would corrupt.
create table public.net_worth_history (
  user_id uuid not null references auth.users (id),
  snapshot_date date not null,
  stocks_eur numeric not null default 0,
  bonds_eur numeric not null default 0,
  crypto_eur numeric not null default 0,
  cash_eur numeric not null default 0,
  liabilities_eur numeric not null default 0,
  total_eur numeric not null,
  created_at timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);

alter table public.net_worth_history enable row level security;

create policy "Users can view own net worth history" on public.net_worth_history
  for select using ((select auth.uid()) = user_id);
