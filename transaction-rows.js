const crypto = require('crypto');

// Primary key is (account_uid, entry_reference), but banks may omit entry_reference.
// A null key, or the same key twice in one upsert, makes Postgres reject the whole
// batch -- the account then silently stops syncing. Derive a stable id for null
// refs; keep one row per key. Identical same-day twins (same fields) get an
// occurrence suffix. ponytail: suffix depends on fetch order, fine while banks
// return a stable order; switch to a bank-provided id if one appears.
function entryReferenceFor(tx, seen) {
  if (tx.entry_reference) return tx.entry_reference;
  const key = [
    tx.booking_date, tx.value_date, tx.transaction_amount?.amount, tx.transaction_amount?.currency,
    tx.credit_debit_indicator, tx.creditor?.name, tx.debtor?.name, (tx.remittance_information || []).join(' '),
  ].join('|');
  const n = seen.get(key) || 0;
  seen.set(key, n + 1);
  return `h:${crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 24)}`;
}

// The bank payload is kept for support and export, minus the counterparty's account number
// (IBAN): nothing reads it, and it is someone else's data.
function rawWithoutAccounts(tx) {
  const { creditor_account: _c, debtor_account: _d, ...rest } = tx;
  return rest;
}

// Uppercase, no spaces: how IBANs are compared.
const normalizeIban = (iban) => (typeof iban === 'string' ? iban.replace(/\s+/g, '').toUpperCase() : '');

// Whether the other side of the transaction is one of the user's own accounts: true or false
// when the bank sent the counterparty's IBAN, null when it didn't (or ownIbans is unknown).
function ownCounterparty(tx, ownIbans) {
  const other = normalizeIban(tx.credit_debit_indicator === 'DBIT' ? tx.creditor_account?.iban : tx.debtor_account?.iban);
  if (!other || !ownIbans) return null;
  return ownIbans.has(other);
}

function mapToRow(tx, accountUid, userId, entryReference, ownIbans) {
  return {
    entry_reference: entryReference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    // The dashboard shows creditor_name as the row's name, so for money coming in it is the payer.
    creditor_name: (tx.credit_debit_indicator === 'CRDT' && tx.debtor?.name) || tx.creditor?.name || null,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(' '),
    booking_date: tx.booking_date,
    value_date: tx.value_date,
    bank_transaction_code: tx.bank_transaction_code?.code || null,
    // Left out when the user's IBANs are unknown, so a failed read keeps what was stored.
    ...(ownIbans && { own_counterparty: ownCounterparty(tx, ownIbans) }),
    raw: rawWithoutAccounts(tx),
    user_id: userId,
  };
}

// ownIbans: the user's own accounts' IBANs, normalized (see normalizeIban); without it rows carry
// no own_counterparty.
function buildRows(transactions, accountUid, userId, ownIbans) {
  const seen = new Map();
  const byRef = new Map(); // Map keeps one row per key, last wins
  for (const tx of transactions) {
    // A pending transaction has no stable id yet: stored now, it would be kept beside its
    // booked copy (a different id) and counted twice. It is stored once the bank books it.
    if (tx.status === 'PDNG') continue;
    const ref = entryReferenceFor(tx, seen);
    byRef.set(ref, mapToRow(tx, accountUid, userId, ref, ownIbans));
  }
  return [...byRef.values()];
}

module.exports = { buildRows, normalizeIban, ownCounterparty };
