-- Codifies a trigger that has existed on the live production DB but was
-- never captured in a migration -- a self-hoster running `supabase db push`
-- from this repo got none of this protection. Denylist, not allowlist: any
-- column NOT listed here (category, transaction_type, worth_it,
-- worth_it_prompted_at, flow_type, personal_amount, owed_by, owed_settled,
-- settled_at) stays writable by the row's own authenticated owner.
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.entry_reference is distinct from old.entry_reference
     or new.account_uid is distinct from old.account_uid
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.credit_debit_indicator is distinct from old.credit_debit_indicator
     or new.creditor_name is distinct from old.creditor_name
     or new.debtor_name is distinct from old.debtor_name
     or new.remittance_info is distinct from old.remittance_info
     or new.booking_date is distinct from old.booking_date
     or new.value_date is distinct from old.value_date
     or new.bank_transaction_code is distinct from old.bank_transaction_code
     or new.raw is distinct from old.raw
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
  then
    raise exception 'Only category and transaction_type may be updated on transactions';
  end if;
  return new;
end;
$function$;

-- Trigger function itself must not be directly callable via RPC.
revoke execute on function public.restrict_transaction_updates() from anon, authenticated;

drop trigger if exists trg_restrict_transaction_updates on public.transactions;
create trigger trg_restrict_transaction_updates
  before update on public.transactions
  for each row
  when (auth.role() = 'authenticated'::text)
  execute function public.restrict_transaction_updates();
