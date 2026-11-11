import { assert, assertMatch, assertNotMatch } from "jsr:@std/assert@1.0.19";
import { buildCategorizePrompt } from "./categorize-prompt.ts";

const credit = {
  entry_reference: "ref-1", creditor_name: null, debtor_name: "Jane Example", remittance_info: "games night",
  amount: 5000, currency: "EUR", credit_debit_indicator: "CRDT",
};

// Regression: a large incoming payment was filed as Entertainment because the payer was never sent.
Deno.test("the prompt sends the payer and says a large incoming payment is a Transfer or Income", () => {
  const prompt = buildCategorizePrompt([credit]);
  assertMatch(prompt, /"debtor_name": "Jane Example"/);
  assertMatch(prompt, /large incoming amount[^.]*is Transfer/);
  for (const field of ["entry_reference", "creditor_name", "remittance_info", "amount", "currency", "direction"]) {
    assert(prompt.includes(`"${field}"`), field);
  }
});

Deno.test("the prompt offers the user's own list and marks the fields as untrusted", () => {
  const prompt = buildCategorizePrompt([credit], ["Groceries", "Gym", "Transfer"]);
  assertMatch(prompt, /exactly one of these categories: Groceries, Gym, Transfer\./);
  assertNotMatch(prompt, /Entertainment/);
  assertMatch(prompt, /untrusted data from third parties/);
});
