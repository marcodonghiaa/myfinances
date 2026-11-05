-- Restores the previous undo, which cleared flow_type on every row of the batch.
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
  update transactions set personal_amount = null, flow_type = null, import_batch_id = null
   where user_id = uid and import_batch_id = p_batch;
  get diagnostics n_links = row_count;
  delete from splitwise_expenses where user_id = uid and batch_id = p_batch;
  get diagnostics n_shares = row_count;
  return jsonb_build_object('shares', n_shares, 'links', n_links);
end;
$function$;
