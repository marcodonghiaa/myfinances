-- A holding that is still held but has no price on the latest day made the whole day dip: the
-- view summed only the rows stamped with the latest snapshot date. Now each held holding (and each
-- crypto asset) keeps its last known value until it is priced again. A holding that is no longer
-- in portfolio_holdings / crypto_holdings is not carried, so a sold position still drops out the
-- day after its last snapshot. With every holding priced every day the output is unchanged.
-- Column list unchanged; the bank part is untouched.
create or replace view public.v_net_worth_daily
with (security_invoker = true) as
with all_dates as (
  select net_worth_snapshots.user_id, net_worth_snapshots.snapshot_date from net_worth_snapshots
  union
  select portfolio_snapshots.user_id, portfolio_snapshots.snapshot_date from portfolio_snapshots
  union
  select crypto_snapshots.user_id, crypto_snapshots.snapshot_date from crypto_snapshots
)
select
  d.user_id,
  d.snapshot_date,
  coalesce(b.bank_total_eur, 0) + coalesce(p.portfolio_total_eur, 0) + coalesce(c.crypto_total_eur, 0) as total_eur,
  coalesce(b.bank_total_eur, 0) as bank_total_eur,
  coalesce(p.portfolio_total_eur, 0) as portfolio_total_eur,
  coalesce(c.crypto_total_eur, 0) as crypto_total_eur,
  coalesce(p.portfolio_bonds_eur, 0) as portfolio_bonds_eur
from (select distinct all_dates.user_id, all_dates.snapshot_date from all_dates) d
left join lateral (
  select sum(e.amount_eur) as bank_total_eur
  from v_net_worth_eur e
  where e.user_id = d.user_id
    and e.snapshot_date = (
      select max(e2.snapshot_date) from v_net_worth_eur e2
      where e2.user_id = d.user_id and e2.snapshot_date <= d.snapshot_date
    )
  group by e.user_id
) b on true
left join lateral (
  select
    sum(x.value_eur) as portfolio_total_eur,
    sum(x.value_eur) filter (where exists (
      select 1 from portfolio_holdings h
      where h.user_id = x.user_id and h.isin = x.isin and h.asset_type = 'Bond'
    )) as portfolio_bonds_eur
  from (
    select distinct on (ps.isin) ps.user_id, ps.isin, ps.snapshot_date, ps.value_eur
    from portfolio_snapshots ps
    where ps.user_id = d.user_id and ps.snapshot_date <= d.snapshot_date
    order by ps.isin, ps.snapshot_date desc
  ) x
  where x.snapshot_date = (
      select max(ps2.snapshot_date) from portfolio_snapshots ps2
      where ps2.user_id = d.user_id and ps2.snapshot_date <= d.snapshot_date
    )
    or exists (
      select 1 from portfolio_holdings h
      where h.user_id = x.user_id and h.isin = x.isin
    )
) p on true
left join lateral (
  select sum(y.value_eur) as crypto_total_eur
  from (
    select distinct on (cs.asset_symbol, cs.source)
      cs.user_id, cs.asset_symbol, cs.source, cs.snapshot_date, cs.value_eur
    from crypto_snapshots cs
    where cs.user_id = d.user_id and cs.snapshot_date <= d.snapshot_date
    order by cs.asset_symbol, cs.source, cs.snapshot_date desc
  ) y
  where y.snapshot_date = (
      select max(cs2.snapshot_date) from crypto_snapshots cs2
      where cs2.user_id = d.user_id and cs2.snapshot_date <= d.snapshot_date
    )
    or exists (
      select 1 from crypto_holdings h
      where h.user_id = y.user_id and h.asset_symbol = y.asset_symbol and h.source = y.source
    )
) c on true
order by d.snapshot_date;
