import { assertEquals } from "jsr:@std/assert@1";
import { applyLearned, fetchLearned, learnedUpdate, planRelearn } from "./learned-categories.ts";

// Regression: a merchant you had set to Housing by hand came back as Shopping on its next
// transaction, because the AI never saw your choices.
Deno.test("a new row takes the category you last set by hand for the same merchant", () => {
  const learned = new Map([["FOUND STUDY SOUTHSIDE", "Housing"]]);
  const { matched, unmatched } = applyLearned([
    { entry_reference: "r1", creditor_name: "FOUND STUDY SOUTHSIDE" },
    { entry_reference: "r2", creditor_name: "NEW SHOP" },
    { entry_reference: "r3", creditor_name: null },
  ], learned);
  assertEquals(matched.map((m) => [m.row.entry_reference, m.category]), [["r1", "Housing"]]);
  assertEquals(unmatched.map((r) => r.entry_reference), ["r2", "r3"]);
});

Deno.test("Transfer learned from you also takes the row out of spending", () => {
  assertEquals(learnedUpdate("Transfer"), { category: "Transfer", category_source: "rule", flow_type: "transfer" });
  assertEquals(learnedUpdate("Housing"), { category: "Housing", category_source: "rule" });
});

Deno.test("fetchLearned keeps the most recent hand-set category per merchant, for that user only", async () => {
  const calls: Record<string, unknown> = {};
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => ((calls[c] = v), q),
    in: (c: string, v: unknown) => ((calls[c] = v), q),
    not: () => q,
    is: () => q,
    order: () => q,
    range: async () => ({
      data: [
        { creditor_name: "A", category: "Housing", booking_date: "2026-10-01" },
        { creditor_name: "A", category: "Shopping", booking_date: "2026-09-01" },
      ],
      error: null,
    }),
  };
  const learned = await fetchLearned({ from: () => q }, "u1", ["A", "A", null]);
  assertEquals(learned.get("A"), "Housing");
  assertEquals([calls.user_id, calls.category_source, calls.creditor_name], ["u1", "manual", ["A"]]);
});

Deno.test("an AI row is corrected to your category; your own and rule rows never are", () => {
  const plan = planRelearn([
    { entry_reference: "ai-wrong", creditor_name: "FOUND STUDY", category: "Shopping", category_source: "ai" },
    { entry_reference: "ai-right", creditor_name: "FOUND STUDY", category: "Housing", category_source: "ai" },
    { entry_reference: "mine", creditor_name: "FOUND STUDY", category: "Shopping", category_source: "manual" },
    { entry_reference: "other", creditor_name: "OTHER", category: "Shopping", category_source: "ai" },
  ], new Map([["FOUND STUDY", "Housing"]]));
  assertEquals(plan.map((p) => [p.row.entry_reference, p.category]), [["ai-wrong", "Housing"]]);
});
