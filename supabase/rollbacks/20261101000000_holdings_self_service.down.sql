drop policy "Users can insert own portfolio holdings" on public.portfolio_holdings;
drop policy "Users can update own portfolio holdings" on public.portfolio_holdings;
drop policy "Users can delete own portfolio holdings" on public.portfolio_holdings;
drop policy "Users can insert own crypto holdings" on public.crypto_holdings;
drop policy "Users can update own crypto holdings" on public.crypto_holdings;
drop policy "Users can delete own crypto holdings" on public.crypto_holdings;

-- Fails if any row now has source 'Manual': move or delete those rows first.
alter table public.crypto_holdings drop constraint crypto_holdings_source_check;
alter table public.crypto_holdings add constraint crypto_holdings_source_check
  check (source in ('Ledger', 'Coinbase'));

alter table public.portfolio_holdings alter column broker_label set default 'Trade Republic';
