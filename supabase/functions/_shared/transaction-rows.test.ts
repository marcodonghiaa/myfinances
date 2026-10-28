import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { buildRows, type EbTransaction } from "./transaction-rows.ts";

const tx = (over: EbTransaction = {}): EbTransaction => ({
  entry_reference: "r1",
  transaction_amount: { amount: "12.50", currency: "EUR" },
  credit_debit_indicator: "DBIT",
  booking_date: "2026-10-01",
  remittance_information: ["coffee"],
  ...over,
});

Deno.test("keeps bank-provided entry_reference", async () => {
  const [row] = await buildRows([tx()], "acc", "user");
  assertEquals(row.entry_reference, "r1");
  assertEquals(row.amount, 12.5);
});

// protects=switching from the Node sync; fails_when=the Deno hash differs from transaction-rows.js,
// which would insert every reference-less transaction a second time.
Deno.test("derived references match the Node sync byte for byte", async () => {
  const rows = await buildRows([tx({ entry_reference: null }), tx({ entry_reference: null })], "acc", "user");
  assertEquals(rows.map((r) => r.entry_reference), ["h:6b5383949650b9219eb070a6", "h:6907b02f0bcbc0227ec20c7f"]);
});

Deno.test("derives a stable non-null reference when the bank omits it", async () => {
  const [a] = await buildRows([tx({ entry_reference: null })], "acc", "user");
  const [b] = await buildRows([tx({ entry_reference: undefined })], "acc", "user");
  assertMatch(a.entry_reference as string, /^h:[0-9a-f]{24}$/);
  assertEquals(a.entry_reference, b.entry_reference);
});

Deno.test("identical reference-less twins stay distinct", async () => {
  const rows = await buildRows([tx({ entry_reference: null }), tx({ entry_reference: null })], "acc", "user");
  assertEquals(rows.length, 2);
  assertNotEquals(rows[0].entry_reference, rows[1].entry_reference);
});

Deno.test("duplicate entry_reference in one batch collapses to one row", async () => {
  const rows = await buildRows([tx(), tx({ remittance_information: ["later"] })], "acc", "user");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].remittance_info, "later");
});

Deno.test("names a credit after the payer and a debit after the payee", async () => {
  const [credit] = await buildRows([tx({
    credit_debit_indicator: "CRDT", creditor: { name: "Me" }, debtor: { name: "GameBoost" },
  })], "acc", "user");
  assertEquals(credit.creditor_name, "GameBoost");
  const [debit] = await buildRows([tx({ creditor: { name: "Spotify" }, debtor: { name: "Me" } })], "acc", "user");
  assertEquals(debit.creditor_name, "Spotify");
});
