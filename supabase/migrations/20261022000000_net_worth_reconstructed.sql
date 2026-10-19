-- Month-end net worth rebuilt from bank and broker statements for months that have neither an
-- imported history row nor a live snapshot. Kept apart from net_worth_history (typed in by the
-- user) and net_worth_snapshots (recorded live) so rebuilt numbers are never mistaken for those.
-- Only the classes the statements cover are filled: stocks and funds, bond-like funds, cash.
-- Crypto, CDs and liabilities are not part of a rebuilt row.

create table public.net_worth_reconstructed (
  user_id uuid not null references auth.users (id),
  snapshot_date date not null,
  stocks_eur numeric not null check (stocks_eur >= 0),
  bonds_eur numeric not null check (bonds_eur >= 0),
  cash_eur numeric not null,
  source text not null default 'statements' check (char_length(source) between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);

alter table public.net_worth_reconstructed enable row level security;

create policy "Users can view own reconstructed net worth" on public.net_worth_reconstructed
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own reconstructed net worth" on public.net_worth_reconstructed
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can delete own reconstructed net worth" on public.net_worth_reconstructed
  for delete using ((select auth.uid()) = user_id);
