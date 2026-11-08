-- Restores the 20261027 alias matching by creditor_name. Run before 20261119000000's rollback.
drop trigger trg_reset_merchant_key on public.transactions;
drop function public.reset_merchant_key();

create or replace function public.apply_merchant_alias() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.custom_name is null and new.creditor_name is not null then
    select alias into new.custom_name
    from public.merchant_aliases
    where user_id = new.user_id and source_name = new.creditor_name;
  end if;
  return new;
end;
$$;

create or replace function public.rename_merchant(
  p_entry_reference text, p_account_uid uuid, p_name text
) returns integer
language plpgsql set search_path = public as $$
declare
  v_source text;
  v_old text;
  v_new text := nullif(btrim(p_name), '');
  v_count integer;
begin
  select creditor_name into v_source from transactions
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
  where user_id = auth.uid() and source_name = v_source;

  if v_new is null then
    delete from merchant_aliases where user_id = auth.uid() and source_name = v_source;
  else
    insert into merchant_aliases (user_id, source_name, alias)
    values (auth.uid(), v_source, v_new)
    on conflict (user_id, source_name) do update set alias = excluded.alias;
  end if;

  update transactions set custom_name = v_new
  where creditor_name = v_source
    and (custom_name is null or custom_name = v_old
         or (entry_reference = p_entry_reference and account_uid is not distinct from p_account_uid));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
