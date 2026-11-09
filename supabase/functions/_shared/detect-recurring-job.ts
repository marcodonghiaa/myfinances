// Detects recurring streams for every user and stores them through upsert_detected_streams.
// Per user: spend rows from transactions, their EUR share from v_transactions_eur (applies
// personal_amount and the fx fallback), merged in memory by account_uid + entry_reference.
// Logs counts and error tags only, never merchant names.
import type { Db } from "./batch-update.ts";
import { errorTag } from "./log-safe.ts";
import { type Charge, detectStreams } from "./recurring.ts";

const PAGE_SIZE = 1000; // PostgREST caps a response at 1000 rows

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

async function pages(query: () => any, order: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0;; from += PAGE_SIZE) {
    let q = query();
    for (const c of order) q = q.order(c);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE_SIZE) return out;
  }
}

async function userCharges(db: Db, user: string): Promise<Charge[]> {
  const order = ["account_uid", "entry_reference"];
  const spend = (t: string, cols: string) =>
    db.from(t).select(cols).eq("user_id", user).eq("credit_debit_indicator", "DBIT").eq("flow_type", "spend");
  const txs = await pages(
    () => spend("transactions", "account_uid, entry_reference, merchant_key, currency, amount, booking_date, category, custom_name, creditor_name, bank_transaction_code, flow_type, credit_debit_indicator, deleted_at, transaction_type").is("deleted_at", null).not("merchant_key", "is", null),
    order,
  );
  const eur = new Map<string, number>();
  for (const r of await pages(() => spend("v_transactions_eur", "account_uid, entry_reference, personal_signed_amount_eur"), order)) {
    if (r.personal_signed_amount_eur != null) eur.set(`${r.account_uid}|${r.entry_reference}`, Math.abs(r.personal_signed_amount_eur));
  }
  return txs.map(({ entry_reference, ...t }) => ({
    ...t,
    amount_eur: eur.get(`${t.account_uid}|${entry_reference}`) ?? null,
  })) as Charge[];
}

export async function runDetection(
  db: Db,
  rpc: Rpc,
  today: string,
  timeLeft: () => boolean,
): Promise<{ users: number; streams: number; failed: number; skipped: number }> {
  const { data, error } = await db.from("accounts").select("user_id").order("user_id").limit(PAGE_SIZE);
  if (error) {
    console.error(`detect-recurring: accounts read failed: ${errorTag(error)}`);
    return { users: 0, streams: 0, failed: 1, skipped: 0 };
  }
  // shortcut: one page of accounts (1000), plenty for a handful of users.
  const ids = [...new Set((data as Row[]).map((r) => r.user_id as string))];
  let users = 0, streams = 0, failed = 0, skipped = 0;
  for (const [i, user] of ids.entries()) {
    if (!timeLeft()) {
      skipped = ids.length - i; // not started: the next run picks them up
      break;
    }
    try {
      const found = detectStreams(await userCharges(db, user), today);
      const rows = [...new Map(found.map((s) => [s.stream_key, s])).values()];
      if (rows.length) {
        const { error } = await rpc("upsert_detected_streams", { p_user: user, p_rows: rows });
        if (error) throw error;
      }
      users++;
      streams += rows.length;
    } catch (err) {
      failed++;
      console.error(`detect-recurring: a user failed: ${errorTag(err)}`);
    }
  }
  return { users, streams, failed, skipped };
}
