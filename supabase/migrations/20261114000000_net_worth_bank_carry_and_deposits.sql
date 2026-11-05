-- Net worth fixes from the audit.
--
-- Bank: the total summed only the accounts that had a balance on the user's latest bank
-- snapshot date, so a bank whose sync failed that day (an expired consent, say) dropped out of
-- net worth entirely. Each account now keeps its last balance, as holdings already do, for up
-- to 30 days and only while it is still in accounts. After that it drops out, so a bank left
-- unlinked for good doesn't count forever.
--
-- Deposits (cd_holdings): they were in the Accounts page total but not in net worth. A deposit
-- now counts from its start date until it matures, at its grown value, inside the bank (cash)
-- total. At maturity the money goes back to a bank account, so it stops counting here.
-- Column list unchanged.
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
  coalesce(b.bank_total_eur, 0) + coalesce(cd.cd_total_eur, 0) + coalesce(p.portfolio_total_eur, 0) + coalesce(c.crypto_total_eur, 0) as total_eur,
  coalesce(b.bank_total_eur, 0) + coalesce(cd.cd_total_eur, 0) as bank_total_eur,
  coalesce(p.portfolio_total_eur, 0) as portfolio_total_eur,
  coalesce(c.crypto_total_eur, 0) as crypto_total_eur,
  coalesce(p.portfolio_bonds_eur, 0) as portfolio_bonds_eur
from (select distinct all_dates.user_id, all_dates.snapshot_date from all_dates) d
left join lateral (
  select sum(x.amount_eur) as bank_total_eur
  from (
    select distinct on (e.account_uid) e.account_uid, e.amount_eur
    from v_net_worth_eur e
    where e.user_id = d.user_id
      and e.snapshot_date <= d.snapshot_date
      and e.snapshot_date > d.snapshot_date - 31
      and exists (select 1 from accounts a where a.uid = e.account_uid)
    order by e.account_uid, e.snapshot_date desc
  ) x
) b on true
left join lateral (
  select sum(
    cd.principal
    * power(1 + cd.annual_rate, (d.snapshot_date - cd.start_date)::numeric / 365.25)
    * coalesce(
        (select r.rate_to_eur from fx_rates r
         where r.currency = cd.currency and r.date <= d.snapshot_date
         order by r.date desc limit 1),
        case when cd.currency = 'EUR' then 1::numeric end)
  ) as cd_total_eur
  from cd_holdings cd
  where cd.user_id = d.user_id
    and cd.start_date <= d.snapshot_date
    and cd.maturity_date > d.snapshot_date
) cd on true
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
