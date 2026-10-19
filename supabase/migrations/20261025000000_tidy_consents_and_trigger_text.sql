-- Two small tidy-ups.
--   * The transaction-update trigger's error message said only category and transaction_type
--     may be updated. The trigger is a denylist: several other columns stay writable by the
--     owner. The message now says what it really blocks.
--   * pending_bank_consents rows are single-use and only valid for 15 minutes, but abandoned
--     ones were never removed. Owners may now delete their own rows, so start-bank-consent can
--     clear its caller's expired ones before issuing a new token.

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
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;

create policy "Users can delete own pending bank consents" on public.pending_bank_consents
  for delete using ((select auth.uid()) = user_id);
