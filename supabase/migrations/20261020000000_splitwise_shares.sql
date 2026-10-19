-- My share of expenses tracked in Splitwise, imported from its CSV export.
--   * splitwise_expenses: one row per expense of mine that is NOT already a bank transaction
--     (a friend paid, or I paid with a method the bank sync does not see). Amount is my share
--     only, positive, in its own currency. A friend's repayment is never stored here.
--     A share I paid by card is already a bank transaction: its row is kept (so a re-import
--     recognises it) with a link to that transaction, and is left out of the euro view.
--   * import_splitwise / undo_splitwise_import: one all-or-nothing call each, so a failed
--     import never leaves half the rows written.
--   * transactions.import_batch_id: tags bank transactions the import changed (their personal
--     amount or transfer flag), so Undo can put them back.
--   * v_splitwise_eur: the shares in euros, using the same latest-rate-on-or-before-the-date
--     rule as v_transactions_eur. A share in a currency with no rate on file is left out, like
--     a bank transaction would be; the import screen checks rates before writing.
--   * v_spend_by_category_monthly / v_income_vs_expenses_monthly now include the shares.
--     spend_history still only fills months that have no live bank spend.

create table public.splitwise_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  group_name text not null check (char_length(group_name) between 1 and 100),
  fingerprint text not null check (char_length(fingerprint) between 1 and 500),
  booking_date date not null,
  description text not null check (char_length(description) <= 300),
  category text check (category is null or char_length(category) <= 100),
  amount numeric not null check (amount > 0 and amount < 1000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  batch_id uuid not null,
  linked_account_uid uuid,
  linked_entry_reference text,
  created_at timestamptz not null default now(),
  unique (user_id, group_name, fingerprint),
  check ((linked_account_uid is null) = (linked_entry_reference is null))
);

create index splitwise_expenses_user_date_idx on public.splitwise_expenses (user_id, booking_date);
create index splitwise_expenses_user_batch_idx on public.splitwise_expenses (user_id, batch_id);

alter table public.splitwise_expenses enable row level security;

create policy "Users can view own splitwise expenses" on public.splitwise_expenses
  for select using ((select auth.uid()) = user_id);
create policy "Users can insert own splitwise expenses" on public.splitwise_expenses
  for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own splitwise expenses" on public.splitwise_expenses
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own splitwise expenses" on public.splitwise_expenses
  for delete using ((select auth.uid()) = user_id);

alter table public.transactions add column import_batch_id uuid;
create index transactions_user_import_batch_idx on public.transactions (user_id, import_batch_id)
  where import_batch_id is not null;

create view public.v_splitwise_eur with (security_invoker = true) as
 select s.user_id,
    s.id,
    s.booking_date,
    s.category,
    s.description,
    s.group_name,
    s.currency,
    s.amount,
    s.amount * fx.rate_to_eur as amount_eur
   from public.splitwise_expenses s
     join lateral (
       select fx_rates.rate_to_eur
       from public.fx_rates
       where fx_rates.currency = s.currency and fx_rates.date <= s.booking_date
       order by fx_rates.date desc
       limit 1
     ) fx on true
  where s.linked_entry_reference is null;

create or replace view public.v_spend_by_category_monthly with (security_invoker = true) as
 select live.user_id, live.month, live.category, sum(live.spend_eur) as spend_eur
   from (
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
        coalesce(category, 'Uncategorized'::text) as category,
        (- personal_signed_amount_eur) as spend_eur
       from public.v_transactions_eur
      where ((personal_signed_amount_eur < (0)::numeric) and (flow_type = 'spend'::text))
     union all
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date,
        coalesce(category, 'Uncategorized'::text),
        amount_eur
       from public.v_splitwise_eur
   ) live
  group by live.user_id, live.month, live.category
 union all
 select h.user_id, h.month, h.category, h.spend_eur
   from public.spend_history h
  where not exists (
    select 1 from public.v_transactions_eur t
     where t.user_id = h.user_id
       and t.flow_type = 'spend'
       and (date_trunc('month'::text, (t.booking_date)::timestamp with time zone))::date = h.month
  );

create or replace view public.v_income_vs_expenses_monthly with (security_invoker = true) as
 select m.user_id, m.month, sum(m.income_eur) as income_eur, sum(m.expenses_eur) as expenses_eur
   from (
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date as month,
        (case when flow_type = 'income' and personal_signed_amount_eur > 0 then personal_signed_amount_eur else 0 end) as income_eur,
        (case when flow_type = 'spend' and personal_signed_amount_eur < 0 then - personal_signed_amount_eur else 0 end) as expenses_eur
       from public.v_transactions_eur
     union all
     select user_id,
        (date_trunc('month'::text, (booking_date)::timestamp with time zone))::date,
        0::numeric,
        amount_eur
       from public.v_splitwise_eur
   ) m
  group by m.user_id, m.month
  order by m.month;

-- Writes one Splitwise import: replaces the group's rows in the date range, inserts the new
-- shares, and applies the confirmed changes to bank transactions. Runs as the caller, so row
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

  delete from splitwise_expenses
   where user_id = uid and group_name = p_group and booking_date between p_from and p_to;

  insert into splitwise_expenses (user_id, group_name, fingerprint, booking_date, description,
      category, amount, currency, batch_id, linked_account_uid, linked_entry_reference)
    select uid, p_group, s.fingerprint, s.booking_date, s.description, s.category, s.amount,
           s.currency, p_batch, s.linked_account_uid, s.linked_entry_reference
      from jsonb_to_recordset(p_shares) as s(fingerprint text, booking_date date, description text,
           category text, amount numeric, currency text, linked_account_uid uuid,
           linked_entry_reference text);
  get diagnostics n_shares = row_count;

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

-- Removes what one import wrote and frees the bank transactions it changed. Values the import
-- replaced are not restored.
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

revoke execute on function public.import_splitwise(uuid, text, date, date, jsonb, jsonb) from public, anon;
revoke execute on function public.undo_splitwise_import(uuid) from public, anon;
grant execute on function public.import_splitwise(uuid, text, date, date, jsonb, jsonb) to authenticated;
grant execute on function public.undo_splitwise_import(uuid) to authenticated;
