// Deno port of transaction-rows.js: Enable Banking transactions -> rows of public.transactions.
// The derived entry_reference must stay byte-identical to the Node one (same key, SHA-1),
// or the switch from the Node sync would insert every reference-less transaction twice.

type Json = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
export type EbTransaction = Record<string, any>;

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Primary key is (account_uid, entry_reference), but banks may omit entry_reference.
// A null key, or the same key twice in one upsert, makes Postgres reject the whole
// batch. Derive a stable id for null refs; identical same-day twins get an occurrence
// suffix. ponytail: suffix depends on fetch order, fine while banks return a stable order.
async function entryReferenceFor(tx: EbTransaction, seen: Map<string, number>): Promise<string> {
  if (tx.entry_reference) return tx.entry_reference;
  const key = [
    tx.booking_date, tx.value_date, tx.transaction_amount?.amount, tx.transaction_amount?.currency,
    tx.credit_debit_indicator, tx.creditor?.name, tx.debtor?.name, (tx.remittance_information || []).join(" "),
  ].join("|");
  const n = seen.get(key) || 0;
  seen.set(key, n + 1);
  return `h:${(await sha1Hex(`${key}|${n}`)).slice(0, 24)}`;
}

function mapToRow(tx: EbTransaction, accountUid: string, userId: string, entryReference: string): Json {
  return {
    entry_reference: entryReference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    // The dashboard shows creditor_name as the row's name, so for money coming in it is the payer.
    creditor_name: (tx.credit_debit_indicator === "CRDT" && tx.debtor?.name) || tx.creditor?.name || null,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(" "),
    booking_date: tx.booking_date,
    value_date: tx.value_date,
    bank_transaction_code: tx.bank_transaction_code?.code || null,
    raw: tx,
    user_id: userId,
  };
}

export async function buildRows(transactions: EbTransaction[], accountUid: string, userId: string): Promise<Json[]> {
  const seen = new Map<string, number>();
  const byRef = new Map<string, Json>(); // one row per key, last wins
  for (const tx of transactions) {
    const ref = await entryReferenceFor(tx, seen);
    byRef.set(ref, mapToRow(tx, accountUid, userId, ref));
  }
  return [...byRef.values()];
}
