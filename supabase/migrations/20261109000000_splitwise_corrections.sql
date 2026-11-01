-- Corrections to rows an earlier Splitwise import stored: expenses added late, edited or removed
-- in Splitwise. The dashboard shows them unticked; this applies only the ones the user ticked,
-- by row id, in one all-or-nothing call. import_splitwise never touches old rows, so this is the
-- only way they change. Not covered by Undo: added rows get p_batch, which Undo is never given.
--
-- A share links only to a bank transaction whose personal amount the import set (flow_type is set
-- only for settle-ups, which are never stored as shares), so:
--   * removing a linked share clears personal_amount and import_batch_id, and leaves flow_type;
--   * editing one recalculates personal_amount with the rule the matcher uses: bank amount times
--     my share over the expense's cost.
--
-- p_add items:    {fingerprint, booking_date, description, category, amount, currency}
-- p_edit items:   {id, old_fingerprint, fingerprint, booking_date, description, amount, currency, cost}
-- p_remove items: {id, old_fingerprint}
-- If a row changed since the review, the whole call fails and nothing is written.
create or replace function public.apply_splitwise_corrections(
  p_batch uuid, p_group text, p_add jsonb, p_edit jsonb, p_remove jsonb
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  uid uuid := auth.uid();
  n_added int;
  n_edited int;
  n_removed int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(p_add) > 5000 or jsonb_array_length(p_edit) > 5000
     or jsonb_array_length(p_remove) > 5000 then
    raise exception 'Too many rows';
  end if;

  -- A missing cost would null the personal amount and count the bank transaction in full.
  if exists (select 1 from jsonb_to_recordset(p_edit) as e(cost numeric, amount numeric)
              where e.cost is null or e.cost <= 0 or e.amount is null or e.amount > e.cost) then
    raise exception 'An edit has no valid cost.';
  end if;

  -- The bank goes first: it reads the links as they were reviewed.
  update transactions t
     set personal_amount = null, import_batch_id = null
    from jsonb_to_recordset(p_remove) as r(id uuid, old_fingerprint text)
    join splitwise_expenses s on s.id = r.id and s.fingerprint = r.old_fingerprint
   where s.user_id = uid and s.group_name = p_group
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference;

  delete from splitwise_expenses s
   using jsonb_to_recordset(p_remove) as r(id uuid, old_fingerprint text)
   where s.id = r.id and s.fingerprint = r.old_fingerprint
     and s.user_id = uid and s.group_name = p_group;
  get diagnostics n_removed = row_count;
  if n_removed <> jsonb_array_length(p_remove) then
    raise exception 'A stored expense changed since the review. Reload and try again.';
  end if;

  update transactions t
     set personal_amount = round(t.amount * e.amount / e.cost, 2)
    from jsonb_to_recordset(p_edit) as e(id uuid, old_fingerprint text, amount numeric, cost numeric)
    join splitwise_expenses s on s.id = e.id and s.fingerprint = e.old_fingerprint
   where s.user_id = uid and s.group_name = p_group
     and t.user_id = uid and t.account_uid = s.linked_account_uid
     and t.entry_reference = s.linked_entry_reference;

  update splitwise_expenses s
     set fingerprint = e.fingerprint,
         booking_date = e.booking_date,
         description = e.description,
         amount = e.amount,
         currency = e.currency
    from jsonb_to_recordset(p_edit) as e(id uuid, old_fingerprint text, fingerprint text,
         booking_date date, description text, amount numeric, currency text)
   where s.id = e.id and s.fingerprint = e.old_fingerprint
     and s.user_id = uid and s.group_name = p_group;
  get diagnostics n_edited = row_count;
  if n_edited <> jsonb_array_length(p_edit) then
    raise exception 'A stored expense changed since the review. Reload and try again.';
  end if;

  insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description,
      category, amount, currency, batch_id)
    select uid, p_group, a.fingerprint, a.booking_date, a.description, a.category, a.amount,
           a.currency, p_batch
      from jsonb_to_recordset(p_add) as a(fingerprint text, booking_date date, description text,
           category text, amount numeric, currency text);
  get diagnostics n_added = row_count;

  return jsonb_build_object('added', n_added, 'edited', n_edited, 'removed', n_removed);
end;
$function$;

revoke execute on function public.apply_splitwise_corrections(uuid, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.apply_splitwise_corrections(uuid, text, jsonb, jsonb, jsonb) to authenticated;
