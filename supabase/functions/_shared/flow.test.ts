import { assertEquals } from "jsr:@std/assert@1";
import { BATCH_SIZE, classifyAll, classifyFlows, markRefunds, resolveFlow } from "./flow.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const batch = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ account_uid: "a", entry_reference: `r${start + i}` }));

// Regression: when updates failed, the same 200 rows came back forever and the sync hung.
Deno.test("stops when the same batch comes back instead of looping forever", async () => {
  const errors = console.error;
  console.error = () => {};
  let fetches = 0;
  try {
    const result = await classifyAll(async () => (fetches++, batch(BATCH_SIZE)), async () => {});
    assertEquals(fetches, 2);
    assertEquals(result, { total: BATCH_SIZE, stuck: true });
  } finally {
    console.error = errors;
  }
});

Deno.test("works through full batches until a short one", async () => {
  const pages = [batch(BATCH_SIZE, 0), batch(BATCH_SIZE, BATCH_SIZE), batch(3, 2 * BATCH_SIZE)];
  let applied = 0;
  const result = await classifyAll(async () => pages.shift() ?? [], async (rows) => void (applied += rows.length));
  assertEquals(result, { total: 2 * BATCH_SIZE + 3, stuck: false });
  assertEquals(applied, result.total);
});

// protects=an Edge Function run ends under its wall clock; fails_when=batches keep starting
// after the budget is spent
Deno.test("stops starting batches once the time is up", async () => {
  let fetches = 0;
  let calls = 0;
  const result = await classifyAll(
    async () => (fetches++, batch(BATCH_SIZE, fetches * BATCH_SIZE)),
    async () => {},
    () => calls++ < 2,
  );
  assertEquals(fetches, 2);
  assertEquals(result, { total: 2 * BATCH_SIZE, stuck: false });
});

Deno.test("EXCHANGE and TOPUP are bank transfers; everything else follows the direction", () => {
  assertEquals(resolveFlow({ bank_transaction_code: "EXCHANGE", credit_debit_indicator: "DBIT" } as never), { flow_type: "transfer", flow_source: "bank" });
  assertEquals(resolveFlow({ bank_transaction_code: "TOPUP", credit_debit_indicator: "CRDT" } as never), { flow_type: "transfer", flow_source: "bank" });
  assertEquals(resolveFlow({ bank_transaction_code: "TRANSFER", credit_debit_indicator: "DBIT" } as never), { flow_type: "spend", flow_source: "default" });
  assertEquals(resolveFlow({ bank_transaction_code: null, credit_debit_indicator: "CRDT" } as never), { flow_type: "income", flow_source: "default" });
});

const rule = (over = {}) => ({ user_id: "u1", match_field: "creditor_name", match_text: "me", set_flow_type: "transfer", ...over });
const row = (over = {}) => ({ user_id: "u1", account_uid: "a", entry_reference: "r", credit_debit_indicator: "DBIT", creditor_name: "Me Savings", ...over });

// protects=the decision order of the plan; fails_when=a weaker signal beats a stronger one
Deno.test("precedence: rule, then own account, then bank code, then direction", () => {
  const exchange = { bank_transaction_code: "EXCHANGE" };
  assertEquals(resolveFlow(row({ own_counterparty: true, ...exchange }), [rule({ set_flow_type: "spend" })]), { flow_type: "spend", flow_source: "rule" });
  assertEquals(resolveFlow(row({ own_counterparty: true, ...exchange }), [rule({ user_id: "u2" })]), { flow_type: "transfer", flow_source: "own_account" });
  assertEquals(resolveFlow(row({ own_counterparty: false, ...exchange })), { flow_type: "transfer", flow_source: "bank" });
  assertEquals(resolveFlow(row({ own_counterparty: null })), { flow_type: "spend", flow_source: "default" });
});

// protects=your flow rule beats a learned Transfer category (D); fails_when=the category wins
Deno.test("learned Transfer category makes a transfer, after your flow rules", () => {
  const learned = { category: "Transfer", category_source: "rule" };
  assertEquals(resolveFlow(row(learned)), { flow_type: "transfer", flow_source: "rule" });
  assertEquals(resolveFlow(row(learned), [rule({ set_flow_type: "spend" })]), { flow_type: "spend", flow_source: "rule" });
  // The AI's Transfer is only a suggestion (listed for review), not a decision.
  assertEquals(resolveFlow(row({ category: "Transfer", category_source: "ai" })), { flow_type: "spend", flow_source: "default" });
});

Deno.test("a rule's spend/income means not a transfer: the row keeps its direction", () => {
  const rules = [rule({ set_flow_type: "spend" })];
  assertEquals(resolveFlow(row({ credit_debit_indicator: "CRDT", own_counterparty: true }), rules), { flow_type: "income", flow_source: "rule" });
  assertEquals(resolveFlow(row(), [rule()]), { flow_type: "transfer", flow_source: "rule" });
});

// protects=what the user decided never changes by itself; fails_when=classifyFlows touches a row with a flow
Deno.test("classifyFlows fills only rows without a flow, with their source; user rows stay", async () => {
  const db = memoryDb({
    category_rules: [rule({ match_text: "savings" }), { ...rule(), set_flow_type: null }],
    transactions: [
      row({ entry_reference: "new-rule" }),
      row({ entry_reference: "new-own", creditor_name: "Bob", own_counterparty: true }),
      row({ entry_reference: "new-default", creditor_name: "Bob" }),
      row({ entry_reference: "locked", flow_type: "spend", flow_source: "user", own_counterparty: true }),
      row({ entry_reference: "legacy", flow_type: "spend", flow_source: "legacy", own_counterparty: true }),
    ],
  });
  await classifyFlows(db);
  assertEquals(db.tables.transactions.map((r) => [r.entry_reference, r.flow_type, r.flow_source]), [
    ["new-rule", "transfer", "rule"],
    ["new-own", "transfer", "own_account"],
    ["new-default", "spend", "default"],
    ["locked", "spend", "user"],
    ["legacy", "spend", "legacy"],
  ]);
});

// protects=rules and own accounts apply even when the Node sync filled the flow first (C);
// fails_when=a recent 'default' row keeps spend, or an old, refunded or bank row is touched
Deno.test("classifyFlows re-resolves recent default rows when something stronger applies", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const dflt = (ref: string, over = {}) =>
    row({ entry_reference: ref, creditor_name: "Bob", flow_type: "spend", flow_source: "default", booking_date: today, deleted_at: null, ...over });
  const db = memoryDb({
    category_rules: [rule({ match_text: "savings" })],
    transactions: [
      dflt("by-rule", { creditor_name: "Me Savings" }),
      dflt("by-own", { own_counterparty: true }),
      dflt("by-learned", { category: "Transfer", category_source: "rule" }),
      dflt("stays"),
      dflt("old", { own_counterparty: true, booking_date: "2000-01-01" }),
      dflt("refunded", { own_counterparty: true, flow_type: "refunded" }),
    ],
  });
  const result = await classifyFlows(db);
  assertEquals(result.reresolved, 3);
  assertEquals(db.tables.transactions.map((r) => [r.entry_reference, r.flow_type, r.flow_source]), [
    ["by-rule", "transfer", "rule"],
    ["by-own", "transfer", "own_account"],
    ["by-learned", "transfer", "rule"],
    ["stays", "spend", "default"],
    ["old", "spend", "default"],
    ["refunded", "refunded", "default"],
  ]);
});

// Test rows for the refund tests: a charge d days ago and a credit c days ago, same merchant/amount.
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
type Tx = Record<string, unknown>;
const charge = (ref: string, merchant: string, ago: number, over: Tx = {}): Tx => ({
  account_uid: "a", entry_reference: ref, amount: 9.99, currency: "EUR", credit_debit_indicator: "DBIT", creditor_name: merchant,
  booking_date: day(ago), flow_type: "spend", flow_source: "default", deleted_at: null, refund_of: null, ...over,
});
const credit = (ref: string, merchant: string, ago: number, over: Tx = {}): Tx =>
  charge(ref, merchant, ago, { credit_debit_indicator: "CRDT", flow_type: "income", ...over });
const flows = (rows: Tx[]) => rows.map((r) => [r.entry_reference, r.flow_type, r.refund_of]);

// Runs fn once, right after the n-th query (1-based) resolves: a write from elsewhere mid-run.
function afterQuery(db: ReturnType<typeof memoryDb>, n: number, fn: () => void) {
  let calls = 0;
  return {
    from(t: string) {
      const q = db.from(t);
      const then = q.then;
      q.then = (resolve: (v: unknown) => void) => then((v: unknown) => (++calls === n && fn(), resolve(v)));
      return q;
    },
  };
}

// protects=a refund pair stops counting as spend and income unless you set either side by hand,
// including merchants with a "not a transfer" rule; fails_when=a rule-sourced pair stays spend and
// income, a hand-set side is overwritten, or the credit loses its link to the charge
Deno.test("markRefunds pairs default, rule and legacy rows, never a flow you set", async () => {
  const pair = (ref: string, merchant: string, source: string, creditSource = source) => [
    charge(`${ref}-d`, merchant, 10, { flow_source: source }),
    credit(`${ref}-c`, merchant, 8, { flow_source: creditSource }),
  ];
  const rows = [...pair("def", "Shop", "default"), ...pair("rul", "PayPal", "rule"), ...pair("leg", "Store", "legacy"), ...pair("usr", "Cafe", "default", "user")];
  assertEquals(await markRefunds(memoryDb({ transactions: rows })), { pairs: 3, failed: 0 });
  assertEquals(flows(rows), [
    ["def-d", "refunded", null], ["def-c", "refunded", "def-d"],
    ["rul-d", "refunded", null], ["rul-c", "refunded", "rul-d"],
    ["leg-d", "refunded", null], ["leg-c", "refunded", "leg-d"],
    ["usr-d", "spend", null], ["usr-c", "income", null],
  ]);
});

// protects=a rule that turns a row into a transfer between the read and the write wins, and the
// half pair it leaves is undone on the next run; fails_when=the update only guards flow_source, or
// the lone refunded credit stays out of income for good
Deno.test("markRefunds leaves a side that became a transfer after the read, and repairs the other next run", async () => {
  const rows = [charge("d", "Shop", 10), credit("c", "Shop", 8)];
  // query 1 is the repair read, 2 the candidates read
  const db = afterQuery(memoryDb({ transactions: rows }), 2, () => Object.assign(rows[0], { flow_type: "transfer", flow_source: "rule" }));
  await markRefunds(db);
  assertEquals(flows(rows), [["d", "transfer", null], ["c", "refunded", "d"]]);
  await markRefunds(memoryDb({ transactions: rows }));
  assertEquals(flows(rows), [["d", "transfer", null], ["c", "income", "d"]]);
});

// protects=a pair whose second write failed is finished, not left half applied; fails_when=one side
// keeps counting as spend or income forever
Deno.test("repair finishes a pair whose charge write failed, and re-pairs one whose credit write failed", async () => {
  const chargeFailed = [charge("d1", "Shop", 10), credit("c1", "Shop", 8, { flow_type: "refunded", refund_of: "d1" })];
  const creditFailed = [charge("d2", "Store", 10, { flow_type: "refunded" }), credit("c2", "Store", 8)];
  const rows = [...chargeFailed, ...creditFailed];
  assertEquals(await markRefunds(memoryDb({ transactions: rows })), { pairs: 1, failed: 0 });
  assertEquals(flows(rows), [["d1", "refunded", null], ["c1", "refunded", "d1"], ["d2", "refunded", null], ["c2", "refunded", "d2"]]);
});

// protects=moving a refunded charge to Transfer leaves its refund as income, without stealing last
// month's identical charge; fails_when=the refund stays 'refunded' or pairs with the older charge
Deno.test("a charge you moved to Transfer: its refund counts as income and never pairs with an older charge", async () => {
  const rows = [
    charge("old", "Netflix", 40),
    charge("d", "Netflix", 10, { flow_type: "transfer", flow_source: "user" }),
    credit("c", "Netflix", 8, { flow_type: "refunded", refund_of: "d" }),
  ];
  assertEquals(await markRefunds(memoryDb({ transactions: rows })), { pairs: 0, failed: 0 });
  assertEquals(flows(rows), [["old", "spend", null], ["d", "transfer", null], ["c", "income", "d"]]);
});

// protects=deleting one side frees the other, and Undo brings the pair back; fails_when=the live side
// stays refunded, or the restored charge never pairs with its own refund again
Deno.test("deleting a side frees the other; undoing the delete restores the pair", async () => {
  const rows = [charge("d", "Shop", 10, { flow_type: "refunded" }), credit("c", "Shop", 8, { flow_type: "refunded", refund_of: "d" })];
  rows[0].deleted_at = "2026-11-01T00:00:00Z";
  await markRefunds(memoryDb({ transactions: rows }));
  assertEquals(flows(rows), [["d", "refunded", null], ["c", "income", "d"]]);
  rows[0].deleted_at = null; // Undo
  await markRefunds(memoryDb({ transactions: rows }));
  assertEquals(flows(rows), [["d", "refunded", null], ["c", "refunded", "d"]]);
});

// protects=a refund landing up to 90 days after its charge keeps its pair even when the charge is
// older than the 180-day read window; fails_when=the repair resets a complete pair at the edge
Deno.test("repair keeps a complete pair whose charge is outside the window", async () => {
  const rows = [charge("d", "Shop", 185, { flow_type: "refunded" }), credit("c", "Shop", 100, { flow_type: "refunded", refund_of: "d" })];
  assertEquals(await markRefunds(memoryDb({ transactions: rows })), { pairs: 0, failed: 0 });
  assertEquals(flows(rows), [["d", "refunded", null], ["c", "refunded", "d"]]);
});

// protects=refund_of names a charge only within the credit's own account; fails_when=a credit on
// another account with the same entry_reference keeps a lone charge refunded
Deno.test("repair matches a credit's charge on the same account only", async () => {
  const rows = [
    charge("x", "Shop", 10, { flow_type: "refunded" }), // account a: its credit was deleted
    credit("c", "Shop", 8, { flow_type: "refunded", refund_of: "x", deleted_at: "2026-11-01T00:00:00Z" }),
    charge("x", "Shop", 10, { account_uid: "b", flow_type: "refunded" }), // account b: complete pair
    credit("c", "Shop", 8, { account_uid: "b", flow_type: "refunded", refund_of: "x" }),
  ];
  await markRefunds(memoryDb({ transactions: rows }));
  assertEquals(rows.map((r) => [r.account_uid, r.entry_reference, r.flow_type]), [
    ["a", "x", "spend"], ["a", "c", "refunded"], ["b", "x", "refunded"], ["b", "c", "refunded"],
  ]);
});

// protects=a flow you set by hand is never changed by the repair; fails_when=a 'user' refunded row
// is reset
Deno.test("repair never touches a row you set", async () => {
  const rows = [charge("d", "Shop", 10, { flow_type: "refunded", flow_source: "user" })];
  await markRefunds(memoryDb({ transactions: rows }));
  assertEquals(flows(rows), [["d", "refunded", null]]);
});

// protects=pairs are found across the 1000-row pages, and a row read twice (another write shifted
// the pages) can't serve two refunds; fails_when=a pair split by a page is missed, or one charge
// pairs with two credits
Deno.test("refund candidates: a pair across pages is found, a row read twice pairs once", async () => {
  const fillers = Array.from({ length: 999 }, (_, i) => charge(`c${String(i).padStart(3, "0")}`, "Filler", 20, { amount: 1000 + i }));
  const rows = [...fillers, charge("d", "Shop", 10), credit("y1", "Shop", 8), credit("y2", "Shop", 7)];
  // After the first candidates page (query 2), a sync inserts a row before it: "d" moves to page 2.
  const db = afterQuery(memoryDb({ transactions: rows }), 2, () => void rows.push(charge("a", "Filler", 20, { amount: 1 })));
  assertEquals(await markRefunds(db), { pairs: 1, failed: 0 });
  assertEquals(rows.filter((r) => r.flow_type === "refunded").map((r) => r.entry_reference), ["d", "y1"]);
});

// protects=a failed refund write shows up (post-sync then answers 500) instead of only a log line;
// fails_when=markRefunds reports failed: 0 when its updates error
Deno.test("markRefunds counts refund writes that failed", async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    const rows = [charge("d", "Shop", 10), credit("c", "Shop", 8)];
    assertEquals(await markRefunds(memoryDb({ transactions: rows }, "update")), { pairs: 1, failed: 2 });
  } finally {
    console.error = errors;
  }
});

// protects=one account's failing lookup (e.g. a bad stored value) doesn't stop refunds for every
// other user; fails_when=markRefunds throws, or touches the failed account's rows blind
Deno.test("a failed charge lookup on one account is counted, the others still repair and pair", async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    const rows = [
      credit("bad-c", "Shop", 8, { account_uid: "bad", flow_type: "refunded", refund_of: "bad-d" }),
      charge("bad-d", "Shop", 10, { account_uid: "bad", flow_type: "refunded" }),
      charge("d1", "Shop", 10), credit("c1", "Shop", 8, { flow_type: "refunded", refund_of: "d1" }), // half pair
      charge("d2", "Store", 10), credit("c2", "Store", 8), // new pair
    ];
    const mem = memoryDb({ transactions: rows });
    const db = {
      from(t: string) {
        const q = mem.from(t);
        const eq = q.eq;
        q.eq = (c: string, v: unknown) => {
          if (c === "account_uid" && v === "bad") q.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: "XX000" } });
          return eq(c, v);
        };
        return q;
      },
    };
    assertEquals(await markRefunds(db), { pairs: 1, failed: 1 });
    assertEquals(rows.map((r) => [r.entry_reference, r.flow_type]), [
      ["bad-c", "refunded"], ["bad-d", "refunded"], ["d1", "refunded"], ["c1", "refunded"], ["d2", "refunded"], ["c2", "refunded"],
    ]);
  } finally {
    console.error = errors;
  }
});
