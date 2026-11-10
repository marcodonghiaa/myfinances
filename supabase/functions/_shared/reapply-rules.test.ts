import { assertEquals } from "jsr:@std/assert@1";
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
