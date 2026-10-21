-- Renaming one transaction renames every transaction from the same bank-provided
-- merchant, past and future. The alias lives here; custom_name stays the per-row result.
create table public.merchant_aliases (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  source_name text not null,
  alias text not null check (length(btrim(alias)) > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, source_name)
);

alter table public.merchant_aliases enable row level security;

create policy "Users manage own aliases" on public.merchant_aliases
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- New bank rows (inserted by the sync) pick up the alias; manual custom_name wins.
create function public.apply_merchant_alias() returns trigger
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

create trigger trg_apply_merchant_alias
  before insert on public.transactions
  for each row execute function public.apply_merchant_alias();

-- Rename (or clear, when p_name is null/blank) a merchant from one of its transactions.
-- Rows the user renamed by hand to something else are left alone. Returns rows changed.
-- Invoker rights: RLS on transactions and merchant_aliases keeps this to the caller's data.
create function public.rename_merchant(
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

revoke all on function public.rename_merchant(text, uuid, text) from public, anon;
grant execute on function public.rename_merchant(text, uuid, text) to authenticated;

-- The trigger function must not be callable as an RPC.
revoke execute on function public.apply_merchant_alias() from public, anon, authenticated;
