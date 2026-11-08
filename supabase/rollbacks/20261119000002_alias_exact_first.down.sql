-- Restores the 20261119000001 alias functions (key first, rename folds aliases per key).
-- New rows pick up the newest alias for their key, else the alias for their exact name.
-- Aggregator keys (PayPal, Apple, Google) cover unrelated payees, so they match by name only.
create or replace function public.apply_merchant_alias() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.custom_name is null and new.creditor_name is not null then
    if new.merchant_key is not null and new.merchant_key not in ('paypal', 'apple', 'google') then
      select alias into new.custom_name
      from public.merchant_aliases
      where user_id = new.user_id and merchant_key = new.merchant_key
      order by created_at desc, source_name
      limit 1;
    end if;
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
  -- An aggregator key spans unrelated payees: rename by exact name instead.
  if v_key in ('paypal', 'apple', 'google') then
    v_key := null;
  end if;
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
  order by created_at desc, source_name
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
