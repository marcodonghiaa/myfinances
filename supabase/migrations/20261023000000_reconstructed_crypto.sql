-- Rebuilt months now include crypto (held quantities valued at that month's prices).
alter table public.net_worth_reconstructed
  add column crypto_eur numeric not null default 0 check (crypto_eur >= 0);
