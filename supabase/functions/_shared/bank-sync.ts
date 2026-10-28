// Deno port of sync-transactions.js + sync-networth.js for ONE account, used by sync-bank.
// Kept free of Deno.env so the tests run with fakes: fetch and supabase come in as deps.

import { buildRows } from "./transaction-rows.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
export type Deps = { fetch: typeof fetch; supabase: Db };

export interface SyncAccount {
  uid: string;
  user_id: string;
  eb_account_uid?: string | null;
  identification_hash?: string | null;
  consent_valid_until?: string | null;
}

export const ACCOUNT_COLUMNS = "uid, user_id, eb_account_uid, identification_hash, consent_valid_until";

const EB = "https://api.enablebanking.com/accounts";
const OVERLAP_DAYS = 7;
const FIRST_SYNC_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

// Statuses with which EB refuses an account id (dead or expired consent).
const EB_REJECTED_STATUSES = new Set([401, 403, 404, 422]);

type EbError = Error & { status?: number; code?: string };

// What may be logged about an error: a code, an HTTP status or a class name. Never the
// message: it can carry names, IBANs, amounts or a raw response body.
export function errorTag(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string" && e.code) return e.code;
  if (typeof e?.status === "number") return `HTTP ${e.status}`;
  if (typeof e?.name === "string") return e.name;
  return "Error";
}

// The id Enable Banking answers to now: a renewed consent can give the same bank
// account a new id (eb_account_uid); null means uid is still it.
const ebAccountId = (account: SyncAccount) => account.eb_account_uid || account.uid;

const rejectedStatus = (err: EbError) => (err.status && EB_REJECTED_STATUSES.has(err.status) ? err.status : null);

async function getEb(fetch: Deps["fetch"], token: string, path: string) {
  const res = await fetch(`${EB}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // code = EB's error name (e.g. EXPIRED_SESSION) when the body is JSON; the body itself is never kept.
    const body = await res.json().catch(() => null);
    const code = /^[A-Z_]+$/.test(body?.error) ? body.error : undefined;
    throw Object.assign(new Error(`API error ${res.status}`), { status: res.status, ...(code && { code }) });
  }
  return res.json();
}

async function getAllTransactions(fetch: Deps["fetch"], token: string, ebId: string, dateFrom: string) {
  const all = [];
  let continuationKey: string | null = null;
  do {
    const params = new URLSearchParams({ date_from: dateFrom });
    if (continuationKey) params.set("continuation_key", continuationKey);
    const data = await getEb(fetch, token, `${ebId}/transactions?${params}`);
    all.push(...(data.transactions || []));
    continuationKey = data.continuation_key || null;
  } while (continuationKey);
  return all;
}

// Rows and the cursor stay under the PK (uid). Never throws for EB failures: rejected carries
// the status when EB refuses the id. cursor = the new last_synced, null when it must not move.
export async function syncAccountTransactions(
  { fetch, supabase }: Deps,
  token: string,
  account: SyncAccount,
  lastSynced: string | null,
  today: string,
) {
  // Re-fetch an overlap before the cursor: banks post transactions days after their
  // booking_date, so a cursor of "today" would skip them forever. Upsert dedupes.
  const from = lastSynced ? Date.parse(lastSynced) - OVERLAP_DAYS * DAY_MS : Date.now() - FIRST_SYNC_DAYS * DAY_MS;
  const dateFrom = new Date(from).toISOString().slice(0, 10);
  try {
    const transactions = await getAllTransactions(fetch, token, ebAccountId(account), dateFrom);
    const rows = await buildRows(transactions, account.uid, account.user_id);
    if (rows.length > 0) {
      const { error } = await supabase.from("transactions").upsert(rows, { onConflict: "account_uid,entry_reference" });
      if (error) {
        console.error(`Supabase insert error: ${errorTag(error)}`);
        return { upserted: 0, rejected: null, cursor: null };
      }
    }
    return { upserted: rows.length, rejected: null, cursor: today };
  } catch (err) {
    console.error(`Failed to sync: ${errorTag(err)}`);
    return { upserted: 0, rejected: rejectedStatus(err as EbError), cursor: null };
  }
}

// Older rows lack identification_hash (and iban): ask EB once and store them. Best effort.
async function fillMissingIds({ fetch, supabase }: Deps, token: string, account: SyncAccount) {
  if (account.identification_hash) return;
  try {
    const details = await getEb(fetch, token, `${ebAccountId(account)}/details`);
    if (!details?.identification_hash) {
      console.error("Account ids not filled: no hash in details");
      return;
    }
    const iban = details.account_id?.iban;
    const patch = { identification_hash: details.identification_hash, ...(iban && { iban }) };
    const { error } = await supabase.from("accounts").update(patch).eq("uid", account.uid);
    if (error) throw error;
  } catch (err) {
    console.error(`Account ids not filled: ${errorTag(err)}`);
  }
}

// EXPIRED_SESSION: the bank closed the consent before consent_valid_until. Ending it today
// shows the Renew banner and the consent push. Never moves a date later. Returns whether marked.
async function markForRenewal(supabase: Db, account: SyncAccount, err: EbError, today: string) {
  if (err.code !== "EXPIRED_SESSION") return false;
  if (account.consent_valid_until && account.consent_valid_until.slice(0, 10) <= today) return false;
  try {
    // Compare-and-set on the date read at start: a Renew during the sync writes a new date
    // that a stale EXPIRED_SESSION must not overwrite.
    const query = supabase.from("accounts").update({ consent_valid_until: today }).eq("uid", account.uid);
    const { error } = await (account.consent_valid_until
      ? query.eq("consent_valid_until", account.consent_valid_until)
      : query.is("consent_valid_until", null));
    if (error) throw error;
    return true;
  } catch (updateErr) {
    console.error(`Account not marked for renewal: ${errorTag(updateErr)}`);
    return false;
  }
}

// The snapshot is saved under the PK (uid). Never throws for EB failures: ebFailed says the bank
// refused or failed the balance call, so the caller can skip spending more calls on it.
export async function syncAccountBalance(deps: Deps, token: string, account: SyncAccount, today: string) {
  await fillMissingIds(deps, token, account);
  try {
    const data = await getEb(deps.fetch, token, `${ebAccountId(account)}/balances`);
    const balance = data.balances?.[0];
    if (!balance) {
      console.log("No balance returned.");
      return { row: null, rejected: null, renewed: false, ebFailed: false };
    }
    const row = {
      account_uid: account.uid,
      currency: balance.balance_amount.currency,
      amount: parseFloat(balance.balance_amount.amount),
      snapshot_date: today,
      user_id: account.user_id,
    };
    return { row, rejected: null, renewed: false, ebFailed: false };
  } catch (err) {
    console.error(`Failed to fetch balance: ${errorTag(err)}`);
    const renewed = await markForRenewal(deps.supabase, account, err as EbError, today);
    return { row: null, rejected: rejectedStatus(err as EbError), renewed, ebFailed: true };
  }
}
