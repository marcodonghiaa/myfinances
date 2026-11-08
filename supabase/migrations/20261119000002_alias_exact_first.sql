-- Two names of one vendor can share a merchant_key with different aliases; both aliases are the user's.
-- New rows take the alias of their exact name first, else the newest alias for their key.
create or replace function public.apply_merchant_alias() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.custom_name is null and new.creditor_name is not null then
    select alias into new.custom_name
    from public.merchant_aliases
    where user_id = new.user_id and source_name = new.creditor_name;
    -- Aggregator keys (PayPal, Apple, Google) cover unrelated payees, so they match by name only.
    if new.custom_name is null and new.merchant_key is not null and new.merchant_key not in ('paypal', 'apple', 'google') then
      select alias into new.custom_name
      from public.merchant_aliases
      where user_id = new.user_id and merchant_key = new.merchant_key
      order by created_at desc, source_name
      limit 1;
    end if;
  end if;
  return new;
end;
$$;

-- Same contract as before; renames every row with the clicked row's key or name.
-- Stores the alias under the clicked row's name only, refreshed so it is the newest for its key;
-- other names' aliases that share the key are kept.
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

  if v_new is null then
    delete from merchant_aliases where user_id = auth.uid() and source_name = v_source;
  else
    insert into merchant_aliases (user_id, source_name, alias, merchant_key)
    values (auth.uid(), v_source, v_new, v_key)
    on conflict (user_id, source_name) do update
      set alias = excluded.alias, merchant_key = excluded.merchant_key, created_at = now();
  end if;

  update transactions set custom_name = v_new
  where ((v_key is not null and merchant_key = v_key) or creditor_name = v_source)
    and (custom_name is null or custom_name = v_old
         or (entry_reference = p_entry_reference and account_uid is not distinct from p_account_uid));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
