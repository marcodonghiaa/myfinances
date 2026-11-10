-- Rollback of 20261128000000_transfer_detection. Flows already set (transfers paired or found by
-- own account) stay as they are; only who decided them and the pairs are dropped.
drop function if exists public.resolve_transfer_pair(uuid, boolean);
drop table if exists public.transfer_pairs;
drop trigger if exists trg_flow_source_user on public.transactions;
drop function if exists public.flow_source_user();
-- The check without own_counterparty, as 20261119000000_merchant_key left it.
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
alter table public.category_rules drop column if exists set_flow_type;
alter table public.transactions drop column if exists own_counterparty, drop column if exists flow_source;
