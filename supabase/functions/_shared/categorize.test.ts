import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { categorize, type Classify } from "./categorize.ts";
import { memoryDb } from "./memory-db.test-helper.ts";
import { classifyFlows } from "./flow.ts";

const tx = (ref: string, creditor: string, over: Record<string, unknown> = {}) => ({
  user_id: "u1", account_uid: "a1", entry_reference: ref, creditor_name: creditor, remittance_info: "",
  amount: 10, currency: "EUR", credit_debit_indicator: "DBIT", booking_date: "2026-11-05",
  category: null, category_source: null, flow_type: null, deleted_at: null, ...over,
});
const seed = () =>
  memoryDb({
    transactions: [
      tx("netflix", "NETFLIX.COM"),
      tx("found", "FOUND STUDY"),
      tx("burger", "TASTY BURGER"),
      tx("past", "FOUND STUDY", { category: "Housing", category_source: "manual", booking_date: "2026-10-01" }),
      tx("mum", "MUM", { category: "Transfer", category_source: "manual", booking_date: "2026-10-01" }),
      tx("mum-new", "MUM"),
      tx("mum-locked", "MUM", { flow_type: "income", flow_source: "user" }),
    ],
    category_rules: [{ user_id: "u1", match_field: "creditor_name", match_text: "netflix", set_category: "Entertainment", set_transaction_type: "Subscription", priority: 100, created_at: "2026-01-01" }],
    user_categories: [],
  });
const byRef = (db: ReturnType<typeof memoryDb>, ref: string) => db.tables.transactions.find((r) => r.entry_reference === ref)!;

// protects=new transactions get categories in the right order (your rules, your past choices,
// then the AI) without a Mac; fails_when=the AI sees rows a rule or past choice covers, or a
// learned Transfer still counts as spend
Deno.test("rules first, then your past choices, then the AI for the rest", async () => {
  const db = seed();
  const sent: string[] = [];
  const classify: Classify = async (rows) => (sent.push(...rows.map((r) => r.entry_reference)), rows.map((r) => ({ entry_reference: r.entry_reference, category: "Dine Out" })));
  const result = await categorize(db, classify);
  assertEquals(sent, ["burger"]);
  assertEquals([byRef(db, "netflix").category, byRef(db, "netflix").category_source, byRef(db, "netflix").transaction_type], ["Entertainment", "rule", "Subscription"]);
  assertEquals([byRef(db, "found").category, byRef(db, "found").category_source], ["Housing", "rule"]);
  await classifyFlows(db); // as post-sync runs it next
  assertEquals([byRef(db, "mum-new").category, byRef(db, "mum-new").flow_type, byRef(db, "mum-new").flow_source], ["Transfer", "transfer", "rule"]);
  // A flow you set yourself stays, even when the category is learned.
  assertEquals([byRef(db, "mum-locked").category, byRef(db, "mum-locked").flow_type], ["Transfer", "income"]);
  assertEquals([byRef(db, "burger").category, byRef(db, "burger").category_source], ["Dine Out", "ai"]);
  assertEquals(result.aiFailed, false);
});

Deno.test("an AI answer outside the user's categories or for an unknown row is ignored", async () => {
  const db = seed();
  const errors = console.warn;
  console.warn = () => {};
  try {
    await categorize(db, async () => [{ entry_reference: "burger", category: "Made Up" }, { entry_reference: "ghost", category: "Shopping" }]);
  } finally {
    console.warn = errors;
  }
  assertEquals(byRef(db, "burger").category, null);
  assert(!db.tables.transactions.some((r) => r.entry_reference === "ghost"));
});

Deno.test("without an AI key your rules and past choices still apply", async () => {
  const db = seed();
  const result = await categorize(db, null);
  assertEquals(result.byRules, 4);
  assertEquals(byRef(db, "netflix").category, "Entertainment");
  assertEquals(byRef(db, "found").category, "Housing");
  assertEquals(byRef(db, "burger").category, null);
});

Deno.test("when the AI fails, rules and past choices still apply and the run reports it", async () => {
  const db = seed();
  const errors = console.error;
  const logged: string[] = [];
  console.error = (m: string) => logged.push(m);
  try {
    const result = await categorize(db, async () => {
      throw Object.assign(new Error("Gemini API error 503: secret prompt text"), { status: 503 });
    });
    assertEquals(result.aiFailed, true);
  } finally {
    console.error = errors;
  }
  assertEquals(byRef(db, "found").category, "Housing");
  assertEquals(logged, ["AI categorization failed, applying your rules only: HTTP 503"]);
});

Deno.test("an AI row takes the category you later set by hand for its merchant", async () => {
  const db = seed();
  db.tables.transactions.push(tx("old-ai", "FOUND STUDY", { category: "Shopping", category_source: "ai", booking_date: "2026-10-15" }));
  const result = await categorize(db, async (rows) => rows.map((r) => ({ entry_reference: r.entry_reference, category: "Dine Out" })));
  assertEquals(result.relearned, 1);
  assertEquals([byRef(db, "old-ai").category, byRef(db, "old-ai").category_source], ["Housing", "rule"]);
});

Deno.test("no AI batch starts once the time is up", async () => {
  const db = seed();
  let calls = 0;
  await categorize(db, async () => (calls++, []), () => false);
  assertEquals(calls, 0);
});
