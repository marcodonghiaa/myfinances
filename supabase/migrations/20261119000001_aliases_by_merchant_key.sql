-- Merchant aliases follow merchant_key, so "LIDL 4521" and "LIDL 4521 MILANO IT" share one rename.
-- Rows without a key yet (manual rows before the backfill) still match on creditor_name.

-- A changed creditor_name makes the old key stale; the backfill recomputes it.
-- A caller that sends a new key with the new name (the sync) keeps it.
create function public.reset_merchant_key() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.creditor_name is distinct from old.creditor_name
     and new.merchant_key is not distinct from old.merchant_key then
    new.merchant_key := null;
  end if;
  return new;
end;
$$;

-- Fires before trg_restrict_transaction_updates (triggers run in name order), which allows a null key.
create trigger trg_reset_merchant_key
  before update of creditor_name on public.transactions
  for each row execute function public.reset_merchant_key();

revoke execute on function public.reset_merchant_key() from public, anon, authenticated;

-- New rows pick up the newest alias for their key, else the alias for their exact name.
create or replace function public.apply_merchant_alias() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.custom_name is null and new.creditor_name is not null then
    select alias into new.custom_name
    from public.merchant_aliases
    where user_id = new.user_id and merchant_key = new.merchant_key
    order by created_at desc
    limit 1;
    if new.custom_name is null then
      select alias into new.custom_name
      from public.merchant_aliases
      where user_id = new.user_id and source_name = new.creditor_name;
    end if;
  end if;
  return new;
end;
$$;

-- Same contract as before; renames every row with the clicked row's key or name.
-- The alias is stored once per key, under the clicked row's name.
create or replace function public.rename_merchant(
  p_entry_reference text, p_account_uid uuid, p_name text
) returns integer
language plpgsql set search_path = public as $$
declare
  v_source text;
  v_key text;
  v_old text;
  v_new text := nullif(btrim(p_name), '');
  v_count integer;
begin
  select creditor_name, merchant_key into v_source, v_key from transactions
  where entry_reference = p_entry_reference
    and account_uid is not distinct from p_account_uid;
  if v_source is null then
    -- No bank name to key on: rename just this row.
    update transactions set custom_name = v_new
    where entry_reference = p_entry_reference
      and account_uid is not distinct from p_account_uid;
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  select alias into v_old from merchant_aliases
  where user_id = auth.uid() and (merchant_key = v_key or source_name = v_source)
  order by created_at desc
  limit 1;

  delete from merchant_aliases
  where user_id = auth.uid() and (merchant_key = v_key or source_name = v_source);
  if v_new is not null then
    insert into merchant_aliases (user_id, source_name, alias, merchant_key)
    values (auth.uid(), v_source, v_new, v_key);
  end if;

  update transactions set custom_name = v_new
  where ((v_key is not null and merchant_key = v_key) or creditor_name = v_source)
    and (custom_name is null or custom_name = v_old
         or (entry_reference = p_entry_reference and account_uid is not distinct from p_account_uid));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
