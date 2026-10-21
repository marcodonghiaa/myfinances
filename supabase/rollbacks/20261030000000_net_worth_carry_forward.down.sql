-- Restores the day-exact definition from 20261028000000_net_worth_daily_bonds.sql.
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
  coalesce(pb.portfolio_bonds_eur, 0) as portfolio_bonds_eur
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
  select sum(ps.value_eur) as portfolio_total_eur
  from portfolio_snapshots ps
  where ps.user_id = d.user_id
    and ps.snapshot_date = (
      select max(ps2.snapshot_date) from portfolio_snapshots ps2
      where ps2.user_id = d.user_id and ps2.snapshot_date <= d.snapshot_date
    )
  group by ps.user_id
) p on true
left join lateral (
  select sum(cs.value_eur) as crypto_total_eur
  from crypto_snapshots cs
  where cs.user_id = d.user_id
    and cs.snapshot_date = (
      select max(cs2.snapshot_date) from crypto_snapshots cs2
      where cs2.user_id = d.user_id and cs2.snapshot_date <= d.snapshot_date
    )
  group by cs.user_id
) c on true
left join lateral (
  select sum(ps.value_eur) as portfolio_bonds_eur
  from portfolio_snapshots ps
  join portfolio_holdings h on h.user_id = ps.user_id and h.isin = ps.isin
  where ps.user_id = d.user_id
    and h.asset_type = 'Bond'
    and ps.snapshot_date = (
      select max(ps2.snapshot_date) from portfolio_snapshots ps2
      where ps2.user_id = d.user_id and ps2.snapshot_date <= d.snapshot_date
    )
) pb on true
order by d.snapshot_date;
