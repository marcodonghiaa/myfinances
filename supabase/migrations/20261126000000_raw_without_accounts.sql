-- transactions.raw kept the full bank payload, including the counterparty's account number
-- (IBAN) on transfers. Nothing reads it, and it is someone else's data, so the sync no longer
-- stores it; this removes it from rows already stored. Every other field of raw is kept.
-- Not reversible: the numbers are gone (the next sync does not bring them back either).
update public.transactions
set raw = raw - 'creditor_account' - 'debtor_account'
where raw ?| array['creditor_account', 'debtor_account'];
