-- Undoing a Splitwise import cleared flow_type on every bank row the import touched, including
-- rows it only gave a personal share: a row you had set to count as income or spend lost that
-- and fell back to the bank-code default at the next sync. Only rows the import turned into a
-- transfer (action mark_transfer) are reset now; the others keep their flow.
create or replace function public.undo_splitwise_import(p_batch uuid) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n_shares int;
  n_links int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  update transactions
     set personal_amount = null,
         flow_type = case when flow_type = 'transfer' then null else flow_type end,
         import_batch_id = null
   where user_id = uid and import_batch_id = p_batch;
  get diagnostics n_links = row_count;
  delete from splitwise_expenses where user_id = uid and batch_id = p_batch;
  get diagnostics n_shares = row_count;
  return jsonb_build_object('shares', n_shares, 'links', n_links);
end;
$function$;

revoke execute on function public.undo_splitwise_import(uuid) from public, anon;
grant execute on function public.undo_splitwise_import(uuid) to authenticated;
