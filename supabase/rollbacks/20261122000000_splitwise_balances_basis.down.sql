-- Rollback of 20261122000000_splitwise_balances_basis: old save function, no basis column.
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

alter table public.splitwise_balances drop column if exists basis;
