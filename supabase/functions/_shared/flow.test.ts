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

// protects=a refund pair stops counting as spend and income unless you set either side by hand,
// including merchants with a "not a transfer" rule; fails_when=a rule-sourced pair stays spend and
// income, a hand-set side is overwritten, or the credit loses its link to the charge
Deno.test("markRefunds pairs default, rule and legacy rows, never a flow you set", async () => {
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
  const pair = (ref: string, merchant: string, source: string, creditSource = source) => [
    { account_uid: "a", entry_reference: `${ref}-d`, amount: 9.99, currency: "EUR", credit_debit_indicator: "DBIT", creditor_name: merchant, booking_date: day(10), flow_type: "spend", flow_source: source, deleted_at: null },
    { account_uid: "a", entry_reference: `${ref}-c`, amount: 9.99, currency: "EUR", credit_debit_indicator: "CRDT", creditor_name: merchant, booking_date: day(8), flow_type: "income", flow_source: creditSource, deleted_at: null },
  ];
  const rows = [...pair("def", "Shop", "default"), ...pair("rul", "PayPal", "rule"), ...pair("leg", "Store", "legacy"), ...pair("usr", "Cafe", "default", "user")];
  assertEquals(await markRefunds(memoryDb({ transactions: rows })), 3);
  assertEquals(rows.map((r) => [r.entry_reference, r.flow_type, (r as { refund_of?: string }).refund_of ?? null]), [
    ["def-d", "refunded", null], ["def-c", "refunded", "def-d"],
    ["rul-d", "refunded", null], ["rul-c", "refunded", "rul-d"],
    ["leg-d", "refunded", null], ["leg-c", "refunded", "leg-d"],
    ["usr-d", "spend", null], ["usr-c", "income", null],
  ]);
});

// protects=a rule that turns a row into a transfer between the read and the write wins;
// fails_when=the refund update only guards flow_source, so a rule transfer becomes refunded
Deno.test("markRefunds leaves a side that became a transfer after the read", async () => {
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
  const rows = [
    { account_uid: "a", entry_reference: "d", amount: 5, currency: "EUR", credit_debit_indicator: "DBIT", creditor_name: "Shop", booking_date: day(10), flow_type: "spend", flow_source: "default", deleted_at: null },
    { account_uid: "a", entry_reference: "c", amount: 5, currency: "EUR", credit_debit_indicator: "CRDT", creditor_name: "Shop", booking_date: day(8), flow_type: "income", flow_source: "default", deleted_at: null },
  ];
  const mem = memoryDb({ transactions: rows });
  let raced = false;
  const db = {
    from(t: string) {
      const q = mem.from(t);
      const then = q.then;
      q.then = (resolve: (v: unknown) => void) =>
        then((v: unknown) => {
          if (!raced) (raced = true), Object.assign(rows[0], { flow_type: "transfer", flow_source: "rule" });
          resolve(v);
        });
      return q;
    },
  };
  await markRefunds(db);
  assertEquals(rows.map((r) => r.flow_type), ["transfer", "refunded"]);
});
