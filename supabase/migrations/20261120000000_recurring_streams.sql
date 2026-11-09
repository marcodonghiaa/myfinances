-- Detected recurring charges ("streams"). Detector columns are written only by upsert_detected_streams
-- (service role); user columns only by stream_action. Users get SELECT on their own rows and nothing else.

create table public.recurring_streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stream_key text not null,
  merchant_key text not null,
  account_uid uuid,
  currency text not null,
  -- detector columns
  display_name text,
  category text,
  cadence text check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly')),
  typical_amount numeric,
  typical_amount_eur numeric,
  charge_count int,
  first_charged date,
  last_charged date,
  next_expected date,
  detected_status text check (detected_status in ('suggested', 'active')),
  is_direct_debit boolean,
  detected_at timestamptz,
  -- user columns
  user_status text check (user_status in ('confirmed', 'dismissed')),
  user_cadence text check (user_cadence in ('weekly', 'monthly', 'quarterly', 'yearly', 'custom')),
  custom_interval_value int,
  custom_interval_unit text check (custom_interval_unit in ('days', 'weeks', 'months', 'years')),
  source text not null default 'bank' check (source in ('bank', 'override')),
  updated_at timestamptz,
  unique (user_id, stream_key)
);

create index recurring_streams_user_idx on public.recurring_streams (user_id);

alter table public.recurring_streams enable row level security;
create policy "Users view own streams" on public.recurring_streams
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.recurring_streams from anon, authenticated;
grant select on public.recurring_streams to authenticated;

-- Detector write path. Never deletes, never touches the user columns, so a dismissed stream stays dismissed.
create or replace function public.upsert_detected_streams(p_user uuid, p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  insert into public.recurring_streams (
    user_id, stream_key, merchant_key, account_uid, currency, display_name, category, cadence,
    typical_amount, typical_amount_eur, charge_count, first_charged, last_charged, next_expected,
    detected_status, is_direct_debit, detected_at)
  select p_user, r.stream_key, r.merchant_key, r.account_uid, r.currency, r.display_name, r.category, r.cadence,
    r.typical_amount, r.typical_amount_eur, r.charge_count, r.first_charged, r.last_charged, r.next_expected,
    r.detected_status, r.is_direct_debit, now()
  from jsonb_populate_recordset(null::public.recurring_streams, p_rows) r
  on conflict (user_id, stream_key) do update set
    merchant_key = excluded.merchant_key,
    account_uid = excluded.account_uid,
    currency = excluded.currency,
    display_name = excluded.display_name,
    category = excluded.category,
    cadence = excluded.cadence,
    typical_amount = excluded.typical_amount,
    typical_amount_eur = excluded.typical_amount_eur,
    charge_count = excluded.charge_count,
    first_charged = excluded.first_charged,
    last_charged = excluded.last_charged,
    next_expected = excluded.next_expected,
    detected_status = excluded.detected_status,
    is_direct_debit = excluded.is_direct_debit,
    detected_at = excluded.detected_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.upsert_detected_streams(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_detected_streams(uuid, jsonb) to service_role;

-- User write path.
create or replace function public.stream_action(p_stream uuid, p_action text, p_args jsonb default '{}')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.recurring_streams where id = p_stream and user_id = auth.uid()) then
    raise exception 'Stream not found';
  end if;
  if p_action = 'confirm' then
    update public.recurring_streams set user_status = 'confirmed', updated_at = now() where id = p_stream;
  elsif p_action = 'dismiss' then
    update public.recurring_streams set user_status = 'dismissed', updated_at = now() where id = p_stream;
  elsif p_action = 'undismiss' then
    update public.recurring_streams set user_status = null, updated_at = now() where id = p_stream;
  elsif p_action = 'set_cadence' then
    if p_args ? 'cadence' then
      update public.recurring_streams
      set user_cadence = p_args->>'cadence', custom_interval_value = null, custom_interval_unit = null,
          user_status = 'confirmed', updated_at = now()
      where id = p_stream;
    elsif (p_args->>'custom_value')::int > 0 and p_args->>'custom_unit' is not null then
      update public.recurring_streams
      set user_cadence = 'custom', custom_interval_value = (p_args->>'custom_value')::int,
          custom_interval_unit = p_args->>'custom_unit', user_status = 'confirmed', updated_at = now()
      where id = p_stream;
    else
      raise exception 'Invalid cadence args';
    end if;
  else
    raise exception 'Unknown stream action: %', p_action;
  end if;
end;
$$;
revoke execute on function public.stream_action(uuid, text, jsonb) from public, anon;
grant execute on function public.stream_action(uuid, text, jsonb) to authenticated;

-- Carry existing billing overrides over. The stream key comes from the user's newest transaction
-- with that creditor_name; overrides with no such transaction are skipped.
insert into public.recurring_streams (
  user_id, stream_key, merchant_key, account_uid, currency, display_name, typical_amount, last_charged,
  user_status, user_cadence, custom_interval_value, custom_interval_unit, source, updated_at, typical_amount_eur)
select o.user_id,
  n.merchant_key || '|' || n.account_uid || '|' || n.currency
    || case when s.amt is not null then '|' || s.amt::text else '' end,
  n.merchant_key, n.account_uid, n.currency, o.creditor_name, abs(n.amount), n.booking_date,
  case when o.dismissed then 'dismissed' else 'confirmed' end,
  case when o.dismissed then null
       when o.custom_interval_value is not null then 'custom'
       else lower(o.billing_frequency) end,
  case when o.dismissed then null else o.custom_interval_value end,
  case when o.dismissed then null else o.custom_interval_unit end,
  'override', now(), e.eur
from public.subscription_billing_overrides o
  join lateral (
    select t.merchant_key, t.account_uid, t.currency, t.amount, t.booking_date
    from public.transactions t
    where t.user_id = o.user_id and t.creditor_name = o.creditor_name
      and t.merchant_key is not null and t.account_uid is not null
      and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
    order by t.booking_date desc
    limit 1
  ) n on true
  -- Aggregator keys carry the cluster's minimum amount. A confirmed override gets that one key; a dismissed
  -- one gets a tombstone per amount, so whichever cluster the detector later finds stays dismissed.
  cross join lateral (
    select null::numeric as amt where n.merchant_key not in ('paypal', 'apple', 'google')
    union all
    (select a.amt
     from (select distinct round(abs(m.amount), 2) as amt from public.transactions m
           where m.user_id = o.user_id and m.creditor_name = o.creditor_name
             and m.account_uid = n.account_uid and m.currency = n.currency
             and m.deleted_at is null and m.credit_debit_indicator = 'DBIT') a
     where n.merchant_key in ('paypal', 'apple', 'google')
     order by a.amt
     limit case when o.dismissed then null else 1 end)
  ) s
  -- typical_amount_eur: your EUR share of the newest live debit for this merchant and account (aggregators: at this amount).
  left join lateral (
    select abs(v.personal_signed_amount_eur) as eur
    from public.transactions t
      join public.v_transactions_eur v
        on v.user_id = t.user_id and v.account_uid = t.account_uid and v.entry_reference = t.entry_reference
    where t.user_id = o.user_id and t.merchant_key = n.merchant_key and t.account_uid = n.account_uid
      and t.deleted_at is null and t.credit_debit_indicator = 'DBIT'
      and v.personal_signed_amount_eur is not null
      and (s.amt is null or round(abs(t.amount), 2) = s.amt)
    order by t.booking_date desc
    limit 1
  ) e on true
where (o.dismissed or o.billing_frequency is not null or o.custom_interval_value is not null)
  -- A dismissed name does not hide a stream that another, never-dismissed name keeps visible with a live
  -- Subscription charge (aggregator names are payees, not variants, so they always keep their tombstones;
  -- a charge with no creditor name never counts as a kept name).
  and not (o.dismissed and n.merchant_key not in ('paypal', 'apple', 'google') and exists (
    select 1 from public.transactions v
    where v.user_id = o.user_id and v.merchant_key = n.merchant_key and v.account_uid = n.account_uid
      and v.transaction_type = 'Subscription' and v.amount <> 0 and v.creditor_name is not null
      and v.deleted_at is null and v.credit_debit_indicator = 'DBIT'
      and not exists (
        select 1 from public.subscription_billing_overrides d
        where d.user_id = v.user_id and d.creditor_name = v.creditor_name and d.dismissed)))
order by o.dismissed -- two names, one stream: the name you kept wins over the one you dismissed
on conflict (user_id, stream_key) do nothing;
