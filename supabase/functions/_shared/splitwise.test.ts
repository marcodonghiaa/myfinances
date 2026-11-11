import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { buildSplitwisePrompt, categorizeSplitwise, planSplitwiseUpdates, SPLITWISE_CATEGORIES } from "./splitwise.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const rows = [
  { id: "id-1", user_id: "u1", description: "Oil + toilet paper", amount: 4.13, currency: "USD", group_name: "berkeley" },
  { id: "id-2", user_id: "u1", description: "marchino", amount: 10.02, currency: "USD", group_name: "berkeley" },
];

Deno.test("prompt carries only id and description, never amounts, group or user, and marks it untrusted", () => {
  const prompt = buildSplitwisePrompt(rows);
  assert(prompt.includes("Oil + toilet paper") && prompt.includes("id-1"));
  for (const secret of ["4.13", "10.02", "berkeley", "u1", "USD"]) assert(!prompt.includes(secret), secret);
  assertMatch(prompt, /untrusted/i);
});

Deno.test("shares are spending: Income, Transfer and Taxes are not offered", () => {
  for (const c of ["Income", "Transfer", "Taxes"]) assert(!SPLITWISE_CATEGORIES.includes(c), c);
  assert(SPLITWISE_CATEGORIES.includes("Housing") && SPLITWISE_CATEGORIES.includes("Others"));
});

Deno.test("keeps one valid answer per row we sent; first answer wins", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assertEquals(planSplitwiseUpdates([
      { entry_reference: "id-1", category: "Pirates" },
      { entry_reference: "id-1", category: "Income" },
      { entry_reference: "zzz", category: "Housing" },
      { entry_reference: "id-2", category: "Others" },
      { entry_reference: "id-2", category: "Groceries" },
    ], rows), [{ id: "id-2", user_id: "u1", category: "Others" }]);
  } finally {
    console.warn = warn;
  }
});

// protects=a category chosen in the import screen is never overwritten; fails_when=the AI's
// answer lands on a share that already has one
Deno.test("only shares without a category are sent and filled", async () => {
  const db = memoryDb({
    splitwise_expenses: [
      { id: "s1", user_id: "u1", description: "tj run", category: null },
      { id: "s2", user_id: "u1", description: "rent", category: "Housing" },
    ],
  });
  const result = await categorizeSplitwise(db, async () => [{ entry_reference: "s1", category: "Groceries" }, { entry_reference: "s2", category: "Others" }]);
  assertEquals(db.tables.splitwise_expenses.map((r) => r.category), ["Groceries", "Housing"]);
  assertEquals(result, { splitwise: 1, splitwiseAiFailed: false });
});

Deno.test("without an AI key nothing happens", async () => {
  const db = memoryDb({ splitwise_expenses: [{ id: "s1", user_id: "u1", description: "x", category: null }] });
  assertEquals(await categorizeSplitwise(db, null), { splitwise: 0, splitwiseAiFailed: false });
  assertEquals(db.tables.splitwise_expenses[0].category, null);
});
