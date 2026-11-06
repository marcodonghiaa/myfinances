import { assertEquals } from "jsr:@std/assert@1";
import { BATCH_SIZE, classifyAll, markRefunds, resolveFlowType } from "./flow.ts";

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

Deno.test("EXCHANGE and TOPUP are transfers; everything else follows the direction", () => {
  assertEquals(resolveFlowType({ bank_transaction_code: "EXCHANGE", credit_debit_indicator: "DBIT" }), "transfer");
  assertEquals(resolveFlowType({ bank_transaction_code: "TOPUP", credit_debit_indicator: "CRDT" }), "transfer");
  assertEquals(resolveFlowType({ bank_transaction_code: "TRANSFER", credit_debit_indicator: "DBIT" }), "spend");
  assertEquals(resolveFlowType({ bank_transaction_code: null, credit_debit_indicator: "CRDT" }), "income");
});

// protects=a refund pair stops counting as spend and income; fails_when=either side keeps its
// flow, the credit loses its link to the charge, or a row the user moved off spend is touched
Deno.test("markRefunds marks both sides refunded, guarded on spend/income", async () => {
  const candidates = [
    { account_uid: "a", entry_reference: "d1", amount: 9.99, currency: "EUR", credit_debit_indicator: "DBIT", creditor_name: "Twitter", booking_date: "2026-10-01" },
    { account_uid: "a", entry_reference: "c1", amount: 9.99, currency: "EUR", credit_debit_indicator: "CRDT", creditor_name: "Twitter", booking_date: "2026-10-03" },
  ];
  const updates: Array<{ update: unknown; refs: unknown; guard: unknown }> = [];
  const db = {
    from: () => {
      let update: unknown = null;
      let refs: unknown = null;
      const q = {
        select: () => q,
        is: () => q,
        gte: () => q,
        order: () => q,
        range: async () => ({ data: candidates, error: null }),
        update: (u: unknown) => ((update = u), q),
        eq: () => q,
        in: (col: string, vals: unknown) => {
          if (col === "entry_reference") refs = vals;
          else if (update) {
            updates.push({ update, refs, guard: vals });
            return Promise.resolve({ error: null });
          }
          return q;
        },
      };
      return q;
    },
  };
  assertEquals(await markRefunds(db), 1);
  assertEquals(updates, [
    { update: { flow_type: "refunded" }, refs: ["d1"], guard: ["spend", "income"] },
    { update: { flow_type: "refunded", refund_of: "d1" }, refs: ["c1"], guard: ["spend", "income"] },
  ]);
});
