-- Each person's net balance in a Splitwise group, as of the last import. Positive: the group owes
-- them; negative: they owe the group. is_me marks the importing user's own row, whose value is
-- what friends owe them. One snapshot per (user, group, person), replaced on every import.
--   * save_splitwise_balances: replaces a group's snapshot in one call. Runs as the caller, so
--     row level security applies.

create table public.splitwise_balances (
  user_id uuid not null references auth.users (id),
  group_name text not null check (char_length(group_name) between 1 and 100),
  person text not null check (char_length(person) between 1 and 100),
  balance numeric not null check (abs(balance) < 1000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  is_me boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, group_name, person)
);

-- At most one "me" per group.
create unique index splitwise_balances_one_me_idx on public.splitwise_balances (user_id, group_name)
  where is_me;

alter table public.splitwise_balances enable row level security;

create policy "Users can view own splitwise balances" on public.splitwise_balances
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own splitwise balances" on public.splitwise_balances
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can delete own splitwise balances" on public.splitwise_balances
  for delete using ((select auth.uid()) = user_id);

create or replace function public.save_splitwise_balances(p_group text, p_balances jsonb)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(p_balances) > 200 then raise exception 'Too many rows'; end if;

  delete from splitwise_balances where user_id = uid and group_name = p_group;

  insert into splitwise_balances (user_id, group_name, person, balance, currency, is_me)
    select uid, p_group, b.person, b.balance, b.currency, coalesce(b.is_me, false)
      from jsonb_to_recordset(p_balances) as b(person text, balance numeric, currency text, is_me boolean);
  get diagnostics n = row_count;

  return jsonb_build_object('balances', n);
end;
$function$;

revoke execute on function public.save_splitwise_balances(text, jsonb) from public, anon;
grant execute on function public.save_splitwise_balances(text, jsonb) to authenticated;
