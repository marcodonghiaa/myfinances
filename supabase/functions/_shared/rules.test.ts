import { assertEquals } from "jsr:@std/assert@1";
import { applyRules, matchRule, planRuleReapply, type Rule } from "./rules.ts";

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

Deno.test("contains (default for older rules) matches anywhere; word and exact do not over-match", () => {
  const barclays = row({ creditor_name: "BARCLAYS UK" });
  assertEquals(matchRule(barclays, rule({ match_text: "bar" })), true);
  assertEquals(matchRule(barclays, rule({ match_text: "bar", match_mode: "word" })), false);
  assertEquals(matchRule(row({ creditor_name: "PAYPAL *BAR-ROMA" }), rule({ match_text: "bar", match_mode: "word" })), true);
  assertEquals(matchRule(row({ creditor_name: "Bàrbara" }), rule({ match_text: "bàr", match_mode: "word" })), false);
  assertEquals(matchRule(row({ creditor_name: "AXB" }), rule({ match_text: "a.b", match_mode: "word" })), false);
  assertEquals(matchRule(row({ creditor_name: "NETFLIX " }), rule({ match_text: " Netflix ", match_mode: "exact" })), true);
  assertEquals(matchRule(row({ creditor_name: "NETFLIX.COM" }), rule({ match_text: "netflix", match_mode: "exact" })), false);
  assertEquals(matchRule(row(), rule({ match_text: "  " })), false);
});

Deno.test("word treats accented letters as letters, in either Unicode form", () => {
  const word = (text: string) => rule({ match_text: text, match_mode: "word" });
  assertEquals(matchRule(row({ creditor_name: "Café Roma" }), word("caf")), false);
  assertEquals(matchRule(row({ creditor_name: "Élan Vital" }), word("lan")), false);
  assertEquals(matchRule(row({ creditor_name: "Cafe\u0301 Roma" }), word("café")), true); // decomposed é
  assertEquals(matchRule(row({ creditor_name: "Cafe\u0301 Roma" }), word("cafe")), false);
});

Deno.test("word checks a boundary only on letter or digit edges", () => {
  assertEquals(matchRule(row({ creditor_name: "AMAZON.IT" }), rule({ match_text: "amazon.", match_mode: "word" })), true);
  assertEquals(matchRule(row({ creditor_name: "PAYPAL*NETFLIX" }), rule({ match_text: "*netflix", match_mode: "word" })), true);
});

Deno.test("contains keeps the text as typed, spaces included", () => {
  assertEquals(matchRule(row(), rule({ match_text: " netflix" })), false);
});

Deno.test("reapply leaves Transfer alone, into it or out of it", () => {
  assertEquals(planRuleReapply([row({ category: "Transfer" })], [rule()]), []);
  assertEquals(planRuleReapply([row()], [rule({ set_category: "Transfer" })]), []);
});
