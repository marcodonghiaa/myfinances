-- A normalized merchant name per transaction (and per alias), so rows from the same merchant
-- group together whatever the bank appended to the name. Written by the bank sync only.

alter table public.transactions add column merchant_key text;
alter table public.merchant_aliases add column merchant_key text;
create index transactions_user_merchant_key_idx on public.transactions (user_id, merchant_key, booking_date);
create index merchant_aliases_user_merchant_key_idx on public.merchant_aliases (user_id, merchant_key);

-- The key is derived from bank data, so users cannot rewrite it (the service role is not limited).
create or replace function public.restrict_transaction_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_manual boolean := exists (select 1 from accounts where uid = old.account_uid and manual);
begin
  if new.entry_reference is distinct from old.entry_reference
     or new.account_uid is distinct from old.account_uid
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.raw is distinct from old.raw
     or new.debtor_name is distinct from old.debtor_name
     or new.remittance_info is distinct from old.remittance_info
     or new.bank_transaction_code is distinct from old.bank_transaction_code
     or (new.merchant_key is not null and new.merchant_key is distinct from old.merchant_key)
     or (not v_manual and (
          new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.credit_debit_indicator is distinct from old.credit_debit_indicator
       or new.creditor_name is distinct from old.creditor_name
       or new.booking_date is distinct from old.booking_date
       or new.value_date is distinct from old.value_date))
  then
    raise exception 'Bank-provided fields on transactions cannot be changed';
  end if;
  return new;
end;
$function$;
