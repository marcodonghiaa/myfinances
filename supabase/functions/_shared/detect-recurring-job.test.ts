import { assertEquals } from "jsr:@std/assert@1";
import { runDetection } from "./detect-recurring-job.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const NAME = "Zorblax Streaming";
const DATES = ["2026-07-05", "2026-08-04", "2026-09-03", "2026-10-03"];
const tx = (user: string, ref: string, date: string, over: Record<string, unknown> = {}) => ({
  user_id: user, account_uid: `a-${user}`, entry_reference: ref, merchant_key: "zorblax", currency: "EUR", amount: 20,
  booking_date: date, category: "Entertainment", custom_name: null, creditor_name: NAME, bank_transaction_code: null,
  flow_type: "spend", credit_debit_indicator: "DBIT", deleted_at: null, ...over,
});
const eur = (user: string, ref: string, v: number | null) => ({
  user_id: user, account_uid: `a-${user}`, entry_reference: ref, flow_type: "spend", credit_debit_indicator: "DBIT",
  personal_signed_amount_eur: v,
});
const seed = (user: string, share = 10) => ({
  transactions: DATES.map((d, i) => tx(user, `${user}${i}`, d)),
  v: DATES.map((_, i) => eur(user, `${user}${i}`, -share)),
});
const build = (users: string[]) => {
  const tables: Record<string, Record<string, unknown>[]> = { accounts: [], transactions: [], v_transactions_eur: [] };
  for (const u of users) {
    const s = seed(u);
    tables.accounts.push({ user_id: u }, { user_id: u });
    tables.transactions.push(...s.transactions);
    tables.v_transactions_eur.push(...s.v);
  }
  return tables;
};
const always = () => true;

function recorder(failFor?: string) {
  const calls: { p_user: string; p_rows: Record<string, unknown>[] }[] = [];
  const rpc = (_fn: string, args: Record<string, unknown>) => {
    const a = args as { p_user: string; p_rows: Record<string, unknown>[] };
    if (a.p_user === failFor) return Promise.resolve({ data: null, error: { code: "XX000", message: NAME } });
    calls.push(a);
    return Promise.resolve({ data: a.p_rows.length, error: null });
  };
  return { calls, rpc };
}

Deno.test("processes each user separately, with the user's EUR share", async () => {
  const { calls, rpc } = recorder();
  const result = await runDetection(memoryDb(build(["u1", "u2"])), rpc, "2026-10-20", always);
  assertEquals(result, { users: 2, streams: 2, failed: 0, skipped: 0 });
  assertEquals(calls.map((c) => c.p_user), ["u1", "u2"]);
  assertEquals(calls[0].p_rows.length, 1);
  assertEquals(calls[0].p_rows[0].account_uid, "a-u1");
  assertEquals(calls[0].p_rows[0].typical_amount, 20);
  assertEquals(calls[0].p_rows[0].typical_amount_eur, 10);
});

Deno.test("a failing user does not stop the other", async () => {
  const { calls, rpc } = recorder("u1");
  const result = await runDetection(memoryDb(build(["u1", "u2"])), rpc, "2026-10-20", always);
  assertEquals(result, { users: 1, streams: 1, failed: 1, skipped: 0 });
  assertEquals(calls.map((c) => c.p_user), ["u2"]);
});

Deno.test("a read failure counts as failed for that user only", async () => {
  const tables = build(["u1"]);
  const db = memoryDb(tables);
  const broken = { from: (t: string) => t === "v_transactions_eur" ? { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { code: "42P01" } }) }) }) }) }) }) }) } : db.from(t) };
  const { rpc } = recorder();
  assertEquals(await runDetection(broken, rpc, "2026-10-20", always), { users: 0, streams: 0, failed: 1, skipped: 0 });
});

Deno.test("accounts read failure is reported, not thrown", async () => {
  const db = { from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "XX000" } }) }) }) }) };
  assertEquals(await runDetection(db, recorder().rpc, "2026-10-20", always), { users: 0, streams: 0, failed: 1, skipped: 0 });
});

Deno.test("stops starting users when time is up", async () => {
  const { calls, rpc } = recorder();
  assertEquals(await runDetection(memoryDb(build(["u1"])), rpc, "2026-10-20", () => false), { users: 0, streams: 0, failed: 0, skipped: 1 });
  assertEquals(calls, []);
});

// protects=stale detector rows get removed; fails_when=the rpc is skipped when a user has no streams left
Deno.test("still calls the rpc with no rows when nothing is detected", async () => {
  const { calls, rpc } = recorder();
  const tables = build(["u1"]);
  tables.transactions = tables.transactions.slice(0, 1);
  assertEquals(await runDetection(memoryDb(tables), rpc, "2026-10-20", always), { users: 1, streams: 0, failed: 0, skipped: 0 });
  assertEquals(calls, [{ p_user: "u1", p_rows: [] }]);
});

Deno.test("ignores deleted, unkeyed, income and credit rows; missing EUR share stays null", async () => {
  const { calls, rpc } = recorder();
  const tables = build(["u1"]);
  tables.transactions.push(
    tx("u1", "d1", "2026-09-10", { deleted_at: "2026-09-11" }),
    tx("u1", "k1", "2026-09-10", { merchant_key: null }),
    tx("u1", "i1", "2026-09-10", { flow_type: "income" }),
    tx("u1", "c1", "2026-09-10", { credit_debit_indicator: "CRDT" }),
  );
  tables.v_transactions_eur[1].personal_signed_amount_eur = null;
  await runDetection(memoryDb(tables), rpc, "2026-10-20", always);
  assertEquals(calls[0].p_rows.length, 1);
  assertEquals(calls[0].p_rows[0].charge_count, 4);
});

Deno.test("pages through more than 1000 charges", async () => {
  const { calls, rpc } = recorder();
  const tables = build(["u1"]); // its refs "u10".. sort after the fillers, past the first page
  for (let i = 0; i < 1100; i++) {
    const ref = `f${String(i).padStart(4, "0")}`;
    tables.transactions.push(tx("u1", ref, "2026-09-01", { merchant_key: `m${i}` }));
    tables.v_transactions_eur.push(eur("u1", ref, -20));
  }
  await runDetection(memoryDb(tables), rpc, "2026-10-20", always);
  assertEquals(calls[0].p_rows.length, 1);
  assertEquals(calls[0].p_rows[0].typical_amount_eur, 10);
});

Deno.test("sends one row per stream_key", async () => {
  // detectStreams never repeats a key today; the guard keeps the RPC safe if it ever does.
  const { calls, rpc } = recorder();
  await runDetection(memoryDb(build(["u1"])), rpc, "2026-10-20", always);
  const keys = calls[0].p_rows.map((r) => r.stream_key);
  assertEquals(new Set(keys).size, keys.length);
});

Deno.test("logs no merchant names", async () => {
  const logs: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a) => void logs.push(a.join(" "));
  console.error = (...a) => void logs.push(a.join(" "));
  try {
    await runDetection(memoryDb(build(["u1", "u2"])), recorder("u1").rpc, "2026-10-20", always);
  } finally {
    console.log = log;
    console.error = err;
  }
  assertEquals(logs.length, 1);
  assertEquals(logs.join("").includes("Zorblax"), false);
});
