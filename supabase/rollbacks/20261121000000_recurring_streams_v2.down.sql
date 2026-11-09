-- Restores the 20261120000000 versions of upsert_detected_streams (no stale-row delete) and stream_action
-- (undismiss always back to undecided). Grants are unchanged by create or replace.
--
-- The data steps are a no-op on purpose: 20261121000000 deletes detector-only rows (the detector recreates them),
-- drops the currency from stream_key, merges rows that then collide, confirms dismissed override rows that a kept
-- override maps to, and fills typical_amount_eur. None of that can be undone exactly, and the old detector would
-- simply write old-shape keys again beside the new ones. Restore from a backup if needed.
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
