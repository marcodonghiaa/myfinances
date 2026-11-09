-- A name you dismissed no longer hides a stream that another of its names keeps visible.
-- The old Subscriptions page hid one creditor name at a time; streams now group every name of a merchant
-- on an account. An imported dismissal of one name hid the whole stream, including the charges of names
-- you never dismissed (dismiss "ACME Ltd" and the "acme.com" charges you kept disappear too).
-- Such a stream is handed back to the detector (undecided, source 'bank'), as a fresh install does: the next
-- run shows it again, or removes it if it no longer finds it.
-- Only imported tombstones: a dismissed billing override maps to the stream (same newest-transaction mapping
-- as 20261120000000) and no kept one does, so a stream you kept and later dismissed on the new page stays
-- dismissed. Aggregators (paypal/apple/google) are left alone: their names are payees, not variants.
-- A charge with no creditor name never counts as a kept name. A second run changes nothing new.
with mapped as (
  select o.user_id, o.dismissed, n.merchant_key || '|' || n.account_uid as key
  from public.subscription_billing_overrides o
    join lateral (
      select t.merchant_key, t.account_uid
      from public.transactions t
      where t.user_id = o.user_id and t.creditor_name = o.creditor_name
        and t.merchant_key is not null and t.account_uid is not null
        and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
      order by t.booking_date desc
      limit 1
    ) n on true
  where o.dismissed or o.billing_frequency is not null or o.custom_interval_value is not null
)
update public.recurring_streams r
set user_status = null, source = 'bank', updated_at = now()
where r.source = 'override' and r.user_status = 'dismissed'
  and r.merchant_key not in ('paypal', 'apple', 'google')
  and exists (select 1 from mapped m where m.user_id = r.user_id and m.key = r.stream_key and m.dismissed)
  and not exists (select 1 from mapped m where m.user_id = r.user_id and m.key = r.stream_key and not m.dismissed)
  and exists (
    select 1 from public.transactions t
    where t.user_id = r.user_id and t.merchant_key = r.merchant_key and t.account_uid = r.account_uid
      and t.transaction_type = 'Subscription' and t.amount <> 0 and t.creditor_name is not null
      and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
      and not exists (
        select 1 from public.subscription_billing_overrides d
        where d.user_id = t.user_id and d.creditor_name = t.creditor_name and d.dismissed));
