// Deno port of transaction-rows.js: Enable Banking transactions -> rows of public.transactions.
// The derived entry_reference must stay byte-identical to the Node one (same key, SHA-1),
// or the switch from the Node sync would insert every reference-less transaction twice.

import { normalizeMerchant } from "./merchant-key.ts";

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

// The bank payload is kept for support and export, minus the counterparty's account number
// (IBAN): nothing reads it, and it is someone else's data.
export function rawWithoutAccounts(tx: EbTransaction): EbTransaction {
  const { creditor_account: _c, debtor_account: _d, ...rest } = tx;
  return rest;
}

// Uppercase, no spaces: how IBANs are compared.
export const normalizeIban = (iban: unknown) => (typeof iban === "string" ? iban.replace(/\s+/g, "").toUpperCase() : "");

// Whether the other side of the transaction is one of the user's own accounts: true or false
// when the bank sent the counterparty's IBAN, null when it didn't (or ownIbans is unknown).
export function ownCounterparty(tx: EbTransaction, ownIbans?: Set<string>): boolean | null {
  const other = normalizeIban(tx.credit_debit_indicator === "DBIT" ? tx.creditor_account?.iban : tx.debtor_account?.iban);
  if (!other || !ownIbans) return null;
  return ownIbans.has(other);
}

function mapToRow(tx: EbTransaction, accountUid: string, userId: string, entryReference: string, ownIbans?: Set<string>): Json {
  const creditorName = (tx.credit_debit_indicator === "CRDT" && tx.debtor?.name) || tx.creditor?.name || null;
  return {
    entry_reference: entryReference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    // The dashboard shows creditor_name as the row's name, so for money coming in it is the payer.
    creditor_name: creditorName,
    merchant_key: normalizeMerchant(creditorName).key,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(" "),
    booking_date: tx.booking_date,
    value_date: tx.value_date,
    bank_transaction_code: tx.bank_transaction_code?.code || null,
    own_counterparty: ownCounterparty(tx, ownIbans),
    raw: rawWithoutAccounts(tx),
    user_id: userId,
  };
}

// ownIbans: the user's own accounts' IBANs, normalized (see normalizeIban).
export async function buildRows(
  transactions: EbTransaction[],
  accountUid: string,
  userId: string,
  ownIbans?: Set<string>,
): Promise<Json[]> {
  const seen = new Map<string, number>();
  const byRef = new Map<string, Json>(); // one row per key, last wins
  for (const tx of transactions) {
    // Pending rows wait until booked: their id changes when booked, so they would count twice.
    if (tx.status === "PDNG") continue;
    const ref = await entryReferenceFor(tx, seen);
    byRef.set(ref, mapToRow(tx, accountUid, userId, ref, ownIbans));
  }
  return [...byRef.values()];
}
