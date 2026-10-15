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

function mapToRow(tx, accountUid, userId, entryReference) {
  return {
    entry_reference: entryReference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    creditor_name: tx.creditor?.name || null,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(' '),
    booking_date: tx.booking_date,
    value_date: tx.value_date,
    bank_transaction_code: tx.bank_transaction_code?.code || null,
    raw: tx,
    user_id: userId,
  };
}

function buildRows(transactions, accountUid, userId) {
  const seen = new Map();
  const byRef = new Map(); // Map keeps one row per key, last wins
  for (const tx of transactions) {
    const ref = entryReferenceFor(tx, seen);
    byRef.set(ref, mapToRow(tx, accountUid, userId, ref));
  }
  return [...byRef.values()];
}

module.exports = { buildRows };
