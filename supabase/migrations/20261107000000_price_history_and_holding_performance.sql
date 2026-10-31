-- Price return per holding. Plain value change counts a purchase as profit; this does not:
-- the function compares prices only, so the dashboard can weight them by today's quantity.
--
-- price_history holds past market prices (Yahoo for stocks and funds, CoinGecko for coins) that
-- the price sync never stored. It is kept apart from portfolio_snapshots / crypto_snapshots on
-- purpose: those feed v_net_worth_daily, and backfilled prices there would rewrite net worth
-- history. Only holding_performance reads price_history. Market data, not personal data, so
-- like fx_rates it has no user_id; signed-in users can read it, only the service role writes.
create table public.price_history (
  provider text not null check (provider in ('yahoo', 'coingecko')),
  symbol text not null check (char_length(symbol) between 1 and 100), -- yahoo_symbol or coingecko_id
  price_date date not null,
  price numeric not null check (price > 0),
  currency text not null check (char_length(currency) between 1 and 10), -- 'USD' for coingecko
  fetched_at timestamptz not null default now(),
  primary key (provider, symbol, price_date)
);

alter table public.price_history enable row level security;
create policy "Authenticated users can view price history" on public.price_history
  for select to authenticated using (true);
-- Supabase grants new tables to anon and authenticated by default; RLS alone would be the only guard.
revoke all on public.price_history from anon;
revoke insert, update, delete, truncate, references, trigger on public.price_history from authenticated;
-- Said outright, not left to Supabase's default grants (which a project can switch off): signed-in
-- users read it (holding_performance runs as the caller), the sync writes it with the service role.
grant select on public.price_history to authenticated;
grant select, insert, update, delete on public.price_history to service_role;

-- One row per held stock/fund (key = isin) and per held coin (key = asset symbol, sources summed),
-- with the price at p_from and the latest price, both in EUR.
--   price series  = snapshot prices plus price_history rows, snapshot winning on the same day, merged
--                   BEFORE looking anything up, so a hole in the snapshots is filled from history.
--   start         = latest price on or before p_from (carried over weekends and holidays);
--                   a holding first priced after p_from starts at its first price.
--   EUR           = price x latest fx rate on or before the price's own date (EUR = 1).
--   status        = ok     start is within 7 days before p_from
--                   since  first price is after p_from: measured from start_date
--                   stale  latest price on or before p_from is older than 7 days (a hole): do not use
--                   no_price  nothing priced, or no fx rate for its currency
--                   stale also covers a price that stopped updating: its latest price is more than
--                   3 days older than the newest latest price among your holdings (a delisted symbol)
-- p_last_move: ignore p_from; start is the latest earlier price that differs from the current one
-- (within 7 days), so "1D" on a Sunday compares Friday with Thursday, not Friday with Friday.
-- A p_from after the latest price gives start = end with status ok (zero length; callers skip it).
-- Sold holdings (quantity 0) are not returned. Only the caller's rows, never anyone else's.
create function public.holding_performance(p_from date, p_last_move boolean default false)
returns table (
  kind text,
  key text,
  name text,
  quantity numeric,
  start_date date,
  start_price_eur numeric,
  end_date date,
  end_price_eur numeric,
  status text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  uid uuid := (select auth.uid());
begin
  if p_from is null then
    raise exception 'p_from is required' using errcode = '22004';
  end if;

  return query
  with held as (
    select 'stock'::text as k, h.isin as ky, h.name as nm, h.shares as q, h.yahoo_symbol as sym
    from public.portfolio_holdings h
    where h.user_id = uid and h.shares > 0
    union all
    select 'crypto', c.asset_symbol, min(c.name), sum(c.amount), min(c.coingecko_id)
    from public.crypto_holdings c
    where c.user_id = uid and c.amount > 0
    group by c.asset_symbol
  ),
  raw as (
    select held.k, held.ky, ps.snapshot_date as d, ps.price, ps.currency as cur, 1 as r
    from held join public.portfolio_snapshots ps
      on held.k = 'stock' and ps.user_id = uid and ps.isin = held.ky
    union all
    select held.k, held.ky, ph.price_date, ph.price, ph.currency, 2
    from held join public.price_history ph
      on held.k = 'stock' and ph.provider = 'yahoo' and ph.symbol = held.sym
    union all
    select held.k, held.ky, cs.snapshot_date, cs.price_usd, 'USD', 1
    from held join public.crypto_snapshots cs
      on held.k = 'crypto' and cs.user_id = uid and cs.asset_symbol = held.ky
    union all
    select held.k, held.ky, ph.price_date, ph.price, ph.currency, 2
    from held join public.price_history ph
      on held.k = 'crypto' and ph.provider = 'coingecko' and ph.symbol = held.sym
  ),
  series as (
    select distinct on (k, ky, d) k, ky, d, price, cur
    from raw
    where price > 0
    order by k, ky, d, r, price
  ),
  last_row as (
    select distinct on (k, ky) k, ky, d, price, cur from series order by k, ky, d desc
  ),
  first_row as (
    select distinct on (k, ky) k, ky, d, price, cur from series order by k, ky, d
  ),
  pick as (
    select h.k, h.ky, h.nm, h.q,
      e.d as ed, e.price as ep, e.cur as ecur,
      coalesce(s.d, f.d) as sd, coalesce(s.price, f.price) as sp, coalesce(s.cur, f.cur) as scur,
      (e.d is not null and s.d is null) as is_since
    from held h
    left join last_row e on e.k = h.k and e.ky = h.ky
    left join first_row f on f.k = h.k and f.ky = h.ky
    left join lateral (
      select x.d, x.price, x.cur
      from series x
      where x.k = h.k and x.ky = h.ky and e.d is not null
        and x.d <= case when p_last_move then e.d - 1 else least(p_from, e.d) end
      order by (p_last_move and x.price is distinct from e.price and x.d >= e.d - 7) desc, x.d desc
      limit 1
    ) s on true
  ),
  priced as (
    select p.*,
      coalesce(
        (select fx.rate_to_eur from public.fx_rates fx
          where fx.currency = p.ecur and fx.date <= p.ed order by fx.date desc limit 1),
        case when p.ecur = 'EUR' then 1::numeric end
      ) as erate,
      coalesce(
        (select fx.rate_to_eur from public.fx_rates fx
          where fx.currency = p.scur and fx.date <= p.sd order by fx.date desc limit 1),
        case when p.scur = 'EUR' then 1::numeric end
      ) as srate
    from pick p
  )
  select
    priced.k, priced.ky, priced.nm, priced.q,
    case when priced.erate is null or priced.srate is null then null else priced.sd end,
    priced.sp * priced.srate,
    case when priced.erate is null or priced.srate is null then null else priced.ed end,
    priced.ep * priced.erate,
    case
      when priced.ed is null or priced.erate is null or priced.srate is null then 'no_price'
      when priced.is_since then 'since'
      when priced.ed < max(priced.ed) over () - 3 then 'stale' -- stopped updating
      when not p_last_move and least(p_from, priced.ed) - priced.sd > 7 then 'stale'
      else 'ok'
    end
  from priced
  order by priced.k, priced.ky;
end;
$$;

revoke all on function public.holding_performance(date, boolean) from public, anon;
grant execute on function public.holding_performance(date, boolean) to authenticated;
