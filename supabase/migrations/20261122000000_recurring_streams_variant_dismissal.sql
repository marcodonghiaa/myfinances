-- A name you dismissed no longer hides a stream that another of its names keeps visible.
-- The old Subscriptions page hid one creditor name at a time; streams now group every name of a merchant
-- on an account. A dismissed name used to carry the whole stream with it (dismiss "ACME Ltd" and the
-- "acme.com" charges you kept disappear too). Such a stream goes back to undecided, so the detector's
-- status shows again, when a live Subscription charge on it comes from a name you never dismissed.
-- Aggregators (paypal/apple/google) are left alone: their names are payees, not variants.
-- Only imported dismissals the detector also finds are touched; a second run changes nothing new.
update public.recurring_streams r
set user_status = null, updated_at = now()
where r.source = 'override' and r.user_status = 'dismissed' and r.detected_status is not null
  and r.merchant_key not in ('paypal', 'apple', 'google')
  and exists (
    select 1 from public.transactions t
    where t.user_id = r.user_id and t.merchant_key = r.merchant_key and t.account_uid = r.account_uid
      and t.transaction_type = 'Subscription' and t.amount <> 0
      and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
      and not exists (
        select 1 from public.subscription_billing_overrides d
        where d.user_id = t.user_id and d.creditor_name = t.creditor_name and d.dismissed));
