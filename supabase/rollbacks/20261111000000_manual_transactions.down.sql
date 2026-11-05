-- Removes manual transactions support. Run after reverting the dashboard and the sync.
-- This deletes every transaction you added by hand, and their manual accounts.
drop function public.add_manual_transaction(date, text, numeric, text, text, text, text);
delete from public.transactions t using public.accounts a where a.uid = t.account_uid and a.manual;
delete from public.accounts where manual;

create or replace view public.v_bank_accounts_latest with (security_invoker = true) as
 select distinct on (a.user_id, a.uid)
    a.user_id, a.uid, a.label, a.iban, a.currency, a.consent_valid_until,
    e.snapshot_date, e.amount, e.amount_eur, a.bank_name, a.bank_logo, a.bank_country
   from public.accounts a
     left join public.v_net_worth_eur e on e.user_id = a.user_id and e.account_uid = a.uid
   order by a.user_id, a.uid, e.snapshot_date desc nulls last;

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

alter table public.accounts drop column manual;
