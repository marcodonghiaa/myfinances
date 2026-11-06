import { assertEquals } from "jsr:@std/assert@1";
import { applyRules, planRuleReapply, type Rule } from "./rules.ts";

const rule = (over: Partial<Rule> = {}): Rule => ({
  user_id: "u1", match_field: "creditor_name", match_text: "netflix", set_category: "Entertainment", set_transaction_type: null, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  user_id: "u1", account_uid: "a1", entry_reference: "r1", creditor_name: "NETFLIX.COM", remittance_info: "",
  category: "Others", category_source: "ai", ...over,
});

Deno.test("applyRules splits rows into matched and unmatched, first rule wins", () => {
  const { matched, unmatched } = applyRules([row(), row({ creditor_name: "Lidl" })], [rule(), rule({ set_category: "Services" })]);
  assertEquals(matched.length, 1);
  assertEquals(matched[0].rule.set_category, "Entertainment");
  assertEquals(unmatched.length, 1);
});

Deno.test("a rule never matches another user's row", () => {
  assertEquals(applyRules([row({ user_id: "u2" })], [rule()]).matched.length, 0);
});

Deno.test('a rule on "any" field matches the remittance too; a rule with no text never matches', () => {
  assertEquals(applyRules([row({ creditor_name: "Card", remittance_info: "netflix monthly" })], [rule({ match_field: "any" })]).matched.length, 1);
  assertEquals(applyRules([row()], [rule({ match_text: null })]).matched.length, 0);
});

Deno.test("reapply plans a category change for an AI-set row", () => {
  assertEquals(planRuleReapply([row()], [rule()]), [{
    account_uid: "a1", entry_reference: "r1", update: { category: "Entertainment", category_source: "rule" },
    guardColumn: "category_source", guardIn: ["ai", "rule"],
  }]);
});

Deno.test("reapply never plans a change for manual or legacy rows, same category, no match or no category", () => {
  assertEquals(planRuleReapply([row({ category_source: "manual" }), row({ entry_reference: "r2", category_source: "legacy" })], [rule()]), []);
  assertEquals(planRuleReapply([row({ category: "Entertainment", category_source: "rule" })], [rule()]), []);
  assertEquals(planRuleReapply([row({ creditor_name: "Lidl" })], [rule()]), []);
  assertEquals(planRuleReapply([row()], [rule({ set_category: null })]), []);
});
