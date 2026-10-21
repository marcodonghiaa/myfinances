-- Importing the same Splitwise group and date range again deleted every row in the range and
-- reinserted it from the file, so a description or category edited in the meantime was lost.
-- import_splitwise now updates rows it already has (matched by fingerprint), keeps their edited
-- description and category, inserts new rows, and deletes only rows in the range that the file
-- no longer contains. Same signature and result, so grants are unchanged.

-- Writes one Splitwise import: brings the group's rows in the date range in line with the file,
-- and applies the confirmed changes to bank transactions. Runs as the caller, so row
-- level security applies. p_links items: {account_uid, entry_reference, action, personal_amount}
-- with action 'set_personal_amount' or 'mark_transfer'. If any bank transaction is no longer
-- free to change, the whole call fails and nothing is written.
create or replace function public.import_splitwise(
  p_batch uuid, p_group text, p_from date, p_to date, p_shares jsonb, p_links jsonb
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n_shares int;
  n_links int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(p_shares) > 5000 or jsonb_array_length(p_links) > 5000 then
    raise exception 'Too many rows';
  end if;

  -- A share already stored (same fingerprint) is updated in place, so a description or category
  -- edited since the last import survives; a category still empty is filled from the file.
  insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description,
      category, amount, currency, batch_id, linked_account_uid, linked_entry_reference)
    select uid, p_group, s.fingerprint, s.booking_date, s.description, s.category, s.amount,
           s.currency, p_batch, s.linked_account_uid, s.linked_entry_reference
      from jsonb_to_recordset(p_shares) as s(fingerprint text, booking_date date, description text,
           category text, amount numeric, currency text, linked_account_uid uuid,
           linked_entry_reference text)
    on conflict (user_id, group_name, fingerprint) do update
      set booking_date = excluded.booking_date,
          category = coalesce(splitwise_expenses.category, excluded.category),
          amount = excluded.amount,
          currency = excluded.currency,
          batch_id = excluded.batch_id,
          linked_account_uid = excluded.linked_account_uid,
          linked_entry_reference = excluded.linked_entry_reference;
  get diagnostics n_shares = row_count;

  delete from splitwise_expenses
   where user_id = uid and group_name = p_group and booking_date between p_from and p_to
     and batch_id is distinct from p_batch;

  update transactions t
     set personal_amount = case l.action when 'set_personal_amount' then l.personal_amount else t.personal_amount end,
         flow_type = case l.action when 'mark_transfer' then 'transfer' else t.flow_type end,
         import_batch_id = p_batch
    from jsonb_to_recordset(p_links) as l(account_uid uuid, entry_reference text, action text, personal_amount numeric)
   where t.user_id = uid and t.account_uid = l.account_uid and t.entry_reference = l.entry_reference
     and l.action in ('set_personal_amount', 'mark_transfer')
     and t.personal_amount is null and t.deleted_at is null
     and t.flow_type is distinct from 'transfer' and t.flow_type is distinct from 'refunded';
  get diagnostics n_links = row_count;
  if n_links <> jsonb_array_length(p_links) then
    raise exception 'A bank transaction changed since the review. Reload and try again.';
  end if;

  -- Links kept from an earlier import now belong to this one, so Undo covers them too.
  update transactions t set import_batch_id = p_batch
    from splitwise_expenses s
   where s.user_id = uid and s.batch_id = p_batch and s.linked_entry_reference is not null
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference
     and t.import_batch_id is distinct from p_batch;

  return jsonb_build_object('shares', n_shares, 'links', n_links);
end;
$function$;
