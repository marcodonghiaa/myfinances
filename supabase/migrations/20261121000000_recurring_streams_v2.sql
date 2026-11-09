-- recurring_streams v2: stream_key drops the currency (merchant|account, aggregators merchant|account|amount),
-- the name you kept beats the one you dismissed, and typical_amount_eur is filled.
-- Idempotent and safe on a fresh install: each step only touches rows still in the old shape, dismissed rows a
-- kept override maps to, or rows still missing a value. A second run changes nothing.

-- Old shape: merchant|account|CUR or merchant|account|CUR|amount. Built from the row's own columns,
-- so a "|" inside a merchant key cannot confuse it.
create temporary table v2_old_keys as
select id, user_id,
  left(p, -1) || coalesce('|' || nullif(substr(rest, 5), ''), '') as new_key
from (
  select id, user_id, p, substr(stream_key, length(p) + 1) as rest
  from (
    select r.*, r.merchant_key || '|' || coalesce(r.account_uid::text, 'null') || '|' as p
    from public.recurring_streams r
  ) k
  where left(stream_key, length(p)) = p
) x
where rest ~ '^[A-Z]{3}(\|[0-9]+(\.[0-9]+)?)?$';

-- b. Detector-only rows (no user choice, not imported) go; the next detector run recreates them. That covers
-- old-shape rows and new-shape rows (a detector run before this migration) that an old-shape row lands on,
-- so a dismissal is never lost to a detector row.
delete from public.recurring_streams r
where r.user_status is null and r.source = 'bank'
  and exists (select 1 from v2_old_keys o where o.id = r.id or (o.user_id = r.user_id and o.new_key = r.stream_key));

-- c. Two rows landing on one new key: keep confirmed, then undecided, then dismissed; tie -> newest updated_at.
-- Rows already in the new shape with a user choice compete too.
delete from public.recurring_streams r
using (
  select id, row_number() over (
    partition by user_id, new_key
    order by case user_status when 'confirmed' then 0 when 'dismissed' then 2 else 1 end,
      updated_at desc nulls last, id
  ) as rn
  from (
    select o.id, o.user_id, o.new_key, r.user_status, r.updated_at
    from v2_old_keys o join public.recurring_streams r on r.id = o.id
    union all
    select r.id, r.user_id, r.stream_key, r.user_status, r.updated_at
    from public.recurring_streams r
    where r.id not in (select id from v2_old_keys)
      and exists (select 1 from v2_old_keys o where o.user_id = r.user_id and o.new_key = r.stream_key)
  ) c
) d
where r.id = d.id and d.rn > 1;

-- a. Rekey what is left.
update public.recurring_streams r
set stream_key = o.new_key
from v2_old_keys o
where r.id = o.id;

-- d. Kept override name wins: a dismissed override row whose key is also the key of a kept (not dismissed)
-- billing override becomes confirmed with that override's cadence and name. Same newest-transaction
-- mapping as 20261120000000; aggregators also match the kept override's minimum amount, so a dismissed
-- PayPal payee is not revived by a kept, unrelated PayPal payee.
update public.recurring_streams r
set user_status = 'confirmed',
  user_cadence = k.user_cadence,
  custom_interval_value = k.custom_interval_value,
  custom_interval_unit = k.custom_interval_unit,
  display_name = k.creditor_name,
  updated_at = now()
from (
  select distinct on (o.user_id, key) o.user_id, o.creditor_name,
    n.merchant_key || '|' || n.account_uid || case when s.amt is not null then '|' || s.amt::text else '' end as key,
    case when o.custom_interval_value is not null then 'custom' else lower(o.billing_frequency) end as user_cadence,
    o.custom_interval_value, o.custom_interval_unit
  from public.subscription_billing_overrides o
    join lateral (
      select t.merchant_key, t.account_uid, t.currency
      from public.transactions t
      where t.user_id = o.user_id and t.creditor_name = o.creditor_name
        and t.merchant_key is not null and t.account_uid is not null
        and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
      order by t.booking_date desc
      limit 1
    ) n on true
    left join lateral (
      select min(round(abs(m.amount), 2)) as amt from public.transactions m
      where n.merchant_key in ('paypal', 'apple', 'google')
        and m.user_id = o.user_id and m.creditor_name = o.creditor_name
        and m.account_uid = n.account_uid and m.currency = n.currency
        and m.deleted_at is null and m.credit_debit_indicator = 'DBIT'
    ) s on true
  where not o.dismissed and (o.billing_frequency is not null or o.custom_interval_value is not null)
  order by o.user_id, key, o.creditor_name
) k
where r.user_id = k.user_id and r.stream_key = k.key
  and r.source = 'override' and r.user_status = 'dismissed';

-- e. typical_amount_eur from the newest live debit for the stream's merchant and account (aggregators:
-- at the stream's amount), your share in EUR as v_transactions_eur computes it.
update public.recurring_streams r
set typical_amount_eur = (
  select abs(v.personal_signed_amount_eur)
  from public.transactions t
    join public.v_transactions_eur v
      on v.user_id = t.user_id and v.account_uid = t.account_uid and v.entry_reference = t.entry_reference
  where t.user_id = r.user_id and t.merchant_key = r.merchant_key and t.account_uid = r.account_uid
    and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
    and v.personal_signed_amount_eur is not null
    and (r.merchant_key not in ('paypal', 'apple', 'google')
         or round(abs(t.amount), 2)::text = split_part(r.stream_key, '|', 3))
  order by t.booking_date desc
  limit 1)
where r.typical_amount_eur is null;

drop table v2_old_keys;
