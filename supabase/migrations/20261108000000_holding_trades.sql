-- Real performance: every buy and sell you made, so returns can be worked out the way a broker does.
-- Owner-only, typed in or imported from CSV in the dashboard. The current quantity stays in the
-- holdings tables (Coinbase sync writes it); the dashboard compares the two and shows no number
-- until they agree. Crypto trades are per coin, not per source: moving a coin between Ledger and
-- Coinbase is not a trade.
create table public.holding_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('stock', 'crypto')),
  key text not null check (char_length(key) between 1 and 100), -- isin, or coin symbol
  side text not null check (side in ('buy', 'sell')),
  trade_date date not null check (trade_date >= '1970-01-01'),
  shares numeric not null check (shares > 0),
  price_eur numeric not null check (price_eur >= 0), -- per share
  fee_eur numeric not null default 0 check (fee_eur >= 0),
  created_at timestamptz not null default now()
);
create index holding_trades_user_key on public.holding_trades (user_id, kind, key, trade_date);

alter table public.holding_trades enable row level security;
create policy "Users can view own trades" on public.holding_trades
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own trades" on public.holding_trades
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own trades" on public.holding_trades
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own trades" on public.holding_trades
  for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.holding_trades from anon;
revoke truncate, references, trigger on public.holding_trades from authenticated;
grant select, insert, update, delete on public.holding_trades to authenticated;
grant select, insert, update, delete on public.holding_trades to service_role;

-- As 20261107000000, plus holdings sold to zero that have trades (quantity 0): their past prices are
-- still needed, or a range that starts while you held them could not be measured.
create or replace function public.holding_performance(p_from date, p_last_move boolean default false)
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
    where h.user_id = uid and (h.shares > 0 or exists (
      select 1 from public.holding_trades t where t.user_id = uid and t.kind = 'stock' and t.key = h.isin
    ))
    union all
    select 'crypto', c.asset_symbol, min(c.name), sum(c.amount), min(c.coingecko_id)
    from public.crypto_holdings c
    where c.user_id = uid
    group by c.asset_symbol
    having sum(c.amount) > 0 or exists (
      select 1 from public.holding_trades t where t.user_id = uid and t.kind = 'crypto' and t.key = c.asset_symbol
    )
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

