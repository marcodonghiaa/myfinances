import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { reapplyRules } from "./reapply-rules.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const tx = (ref: string, creditor: string, over: Record<string, unknown> = {}) => ({
  user_id: "u1", account_uid: "a1", entry_reference: ref, creditor_name: creditor, remittance_info: "",
  category: "Others", category_source: "ai", deleted_at: null, ...over,
});
const rule = (over: Record<string, unknown> = {}) => ({
  user_id: "u1", match_field: "creditor_name", match_text: "bar", match_mode: "word", set_category: "Dine Out",
  set_transaction_type: null, priority: 100, created_at: "2026-01-01", ...over,
});
const seed = (rules = [rule()]) =>
  memoryDb({
    transactions: [
      tx("ai", "Bar Roma"),
      tx("rule", "BAR CENTRALE", { category: "Shopping", category_source: "rule" }),
      tx("manual", "Bar Roma", { category: "Groceries", category_source: "manual" }),
      tx("legacy", "Bar Roma", { category: "Groceries", category_source: "legacy" }),
      tx("barclays", "BARCLAYS"),
      tx("same", "Bar Sport", { category: "Dine Out" }),
      tx("deleted", "Bar Roma", { deleted_at: "2026-11-01" }),
      tx("other-user", "Bar Roma", { user_id: "u2" }),
    ],
    category_rules: [...rules, rule({ user_id: "u2", set_category: "Travel" })],
  });
const cat = (db: ReturnType<typeof seed>, ref: string) => db.tables.transactions.find((r) => r.entry_reference === ref)!.category;

Deno.test("preview counts the changes and writes nothing", async () => {
  const db = seed();
  const result = await reapplyRules(db, "u1", false);
  assertEquals(result.changes, 2);
  assertEquals(result.sample, [{ name: "Bar Roma", from: "Others", to: "Dine Out" }, { name: "BAR CENTRALE", from: "Shopping", to: "Dine Out" }]);
  assertEquals(cat(db, "ai"), "Others");
});

Deno.test("apply changes AI and rule rows only, never hand-set, deleted or other users' rows", async () => {
  const db = seed();
  assertEquals((await reapplyRules(db, "u1", true)).changes, 2);
  assertEquals(["ai", "rule", "manual", "legacy", "barclays", "deleted", "other-user"].map((r) => cat(db, r)), ["Dine Out", "Dine Out", "Groceries", "Groceries", "Others", "Others", "Others"]);
  assertEquals(db.tables.transactions.find((r) => r.entry_reference === "ai")!.category_source, "rule");
  assertEquals((await reapplyRules(db, "u1", false)).changes, 0); // nothing left to do
});

Deno.test("no rules with a category: nothing to do", async () => {
  const db = seed([rule({ set_category: null })]);
  assertEquals(await reapplyRules(db, "u1", true), { changes: 0, sample: [] });
});

Deno.test("more than one page: every row is planned and applied, the sample stays at 5", async () => {
  const many = Array.from({ length: 1001 }, (_, i) => tx(`r${String(i).padStart(4, "0")}`, "Bar Roma"));
  const db = memoryDb({ transactions: many, category_rules: [rule()] });
  const preview = await reapplyRules(db, "u1", false);
  assertEquals([preview.changes, preview.sample.length], [1001, 5]);
  assertEquals((await reapplyRules(db, "u1", true)).changes, 1001);
  assertEquals(db.tables.transactions.filter((r) => r.category === "Dine Out").length, 1001);
  assertEquals((await reapplyRules(db, "u1", false)).changes, 0);
});

Deno.test("a failed write throws instead of reporting success", async () => {
  const db = memoryDb({ transactions: [tx("ai", "Bar Roma")], category_rules: [rule()] }, "update");
  await assertRejects(() => reapplyRules(db, "u1", true));
});

// A deleted "contains bar" rule had filed Barclays as Dine Out; the rule that's left is word-only.
const retiredBar = { user_id: "", match_field: "creditor_name", match_text: "bar", match_mode: "contains", set_category: "Dine Out" };
const seedRetired = () =>
  memoryDb({
    transactions: [
      tx("barclays", "BARCLAYS", { category: "Dine Out", category_source: "rule" }),
      tx("still-ruled", "Bar Roma", { category: "Dine Out", category_source: "rule" }),
      tx("learned", "Pizzeria Da Mario", { category: "Dine Out", category_source: "rule" }),
      tx("ai", "BARBIERE", { category: "Dine Out", category_source: "ai" }),
      tx("manual", "BAR X", { category: "Dine Out", category_source: "manual" }),
      tx("moved", "BARNES", { category: "Shopping", category_source: "rule" }),
      tx("other-user", "BARCLAYS", { user_id: "u2", category: "Dine Out", category_source: "rule" }),
    ],
    category_rules: [rule(), rule({ user_id: "u2", match_mode: "contains" })],
  });

Deno.test("retired rule: preview finds only rule rows it filed that no remaining rule explains", async () => {
  const db = seedRetired();
  const result = await reapplyRules(db, "u1", false, retiredBar);
  assertEquals(result, { changes: 1, sample: [{ name: "BARCLAYS", from: "Dine Out", to: null }] });
  assertEquals(cat(db, "barclays"), "Dine Out");
});

Deno.test("retired rule: apply clears them for the next sync, nothing else changes", async () => {
  const db = seedRetired();
  assertEquals((await reapplyRules(db, "u1", true, retiredBar)).changes, 1);
  const row = (ref: string) => db.tables.transactions.find((r) => r.entry_reference === ref)!;
  assertEquals([row("barclays").category, row("barclays").category_source], [null, null]);
  assertEquals(["still-ruled", "learned", "ai", "manual", "moved", "other-user"].map((r) => cat(db, r)), ["Dine Out", "Dine Out", "Dine Out", "Dine Out", "Shopping", "Dine Out"]);
  assertEquals((await reapplyRules(db, "u1", false, retiredBar)).changes, 0);
});

Deno.test("retired rule: works when no rule is left, and never touches Transfer", async () => {
  const db = memoryDb({
    transactions: [tx("t", "BARCLAYS", { category: "Transfer", category_source: "rule" }), tx("d", "BARCLAYS", { category: "Dine Out", category_source: "rule" })],
    category_rules: [],
  });
  assertEquals((await reapplyRules(db, "u1", false, { ...retiredBar, set_category: "Transfer" })).changes, 0);
  assertEquals((await reapplyRules(db, "u1", true, retiredBar)).changes, 1);
  assertEquals(cat(db, "t"), "Transfer");
});

// Polish 1 #2: a retired rule can only have filed rule rows in its own category; reading every
// AI row too made each delete scan the whole history.
Deno.test("retired rule: reads only rule rows in that rule's category", async () => {
  const many = Array.from({ length: 1001 }, (_, i) => tx(`ai${String(i).padStart(4, "0")}`, "BARCLAYS"));
  const db = memoryDb({ transactions: [...many, tx("hit", "BARCLAYS", { category: "Dine Out", category_source: "rule" })], category_rules: [] });
  let pages = 0;
  const counting = { ...db, from: (t: string) => (t === "transactions" && pages++, db.from(t)) };
  assertEquals((await reapplyRules(counting, "u1", false, retiredBar)).changes, 1);
  assertEquals(pages, 1);
});

// Polish 1 #4: a row learned (source 'rule') before the rule existed, same category, that the
// deleted rule also matches, is reset too: the next sync's learning step gives it back.
Deno.test("retired rule: a learned row it also matches is reset with the others", async () => {
  const db = memoryDb({
    transactions: [tx("learned-first", "Bar Roma", { category: "Dine Out", category_source: "rule" })],
    category_rules: [],
  });
  assertEquals((await reapplyRules(db, "u1", true, retiredBar)).changes, 1);
  assertEquals(cat(db, "learned-first"), null);
});

// Polish 1 #11: a row another rule now files under a different category is not reset; that's
// "Apply to past transactions"' job.
Deno.test("retired rule: keeps a row a remaining rule matches, whatever that rule's category", async () => {
  const db = memoryDb({
    transactions: [tx("bank", "BARCLAYS", { category: "Dine Out", category_source: "rule" })],
    category_rules: [rule({ match_text: "barclays", set_category: "Bank fees" })],
  });
  assertEquals((await reapplyRules(db, "u1", true, retiredBar)).changes, 0);
  assertEquals(cat(db, "bank"), "Dine Out");
});

// Polish 2 #1: postgrest-js doesn't escape a quote inside an in() value, so a category like
// `x","Groceries` would widen an in-list guard. The retire write compares the category exactly.
Deno.test("retired rule: the write guards the category with eq, not an in-list", async () => {
  const db = memoryDb({ transactions: [tx("hit", "BARCLAYS", { category: "Dine Out", category_source: "rule" })], category_rules: [] });
  const guards: string[] = [];
  const spy = {
    ...db,
    from(t: string) {
      const q = db.from(t);
      const wrap = (inner: Record<string, unknown>): Record<string, unknown> =>
        new Proxy(inner, {
          get(target, prop) {
            const v = target[prop as string];
            if (typeof v !== "function" || prop === "then") return typeof v === "function" ? v.bind(target) : v;
            return (...args: unknown[]) => {
              if ((prop === "eq" || prop === "in") && args[0] === "category") guards.push(String(prop));
              const r = (v as (...a: unknown[]) => unknown).apply(target, args);
              return r === target ? wrap(target) : r;
            };
          },
        });
      return wrap(q);
    },
  };
  assertEquals((await reapplyRules(spy, "u1", true, retiredBar)).changes, 1);
  assertEquals(guards, ["eq", "eq"]); // the read and the write
});
