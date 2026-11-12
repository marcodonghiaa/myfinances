import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1.0.19";
import { buildRows, type EbTransaction, normalizeIban, ownCounterparty } from "./transaction-rows.ts";

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

Deno.test("pending transactions are left out until the bank books them", async () => {
  const rows = await buildRows(
    [tx({ entry_reference: null, status: "PDNG", booking_date: null }), tx({ entry_reference: "b1", status: "BOOK" })],
    "acc",
    "u1",
  );
  assertEquals(rows.map((r) => (r as { entry_reference: string }).entry_reference), ["b1"]);
});

Deno.test("merchant_key is the normalized creditor_name the row shows", async () => {
  const [out] = await buildRows([tx({ creditor: { name: "LIDL 4521 MILANO IT" } })], "acc", "user");
  assertEquals(out.merchant_key, "lidl");
  const [inc] = await buildRows(
    [tx({ credit_debit_indicator: "CRDT", debtor: { name: "Mario Rossi" } })], "acc", "user");
  assertEquals(inc.merchant_key, "mario rossi");
  const [none] = await buildRows([tx()], "acc", "user");
  assertEquals(none.merchant_key, null);
});

// protects=counterparties' IBANs; fails_when=raw keeps creditor_account or debtor_account.
Deno.test("raw drops the counterparty account numbers, keeps the rest", async () => {
  const [row] = await buildRows([tx({
    creditor_account: { iban: "DE89370400440532013000" },
    debtor_account: { iban: "IT60X0542811101000000123456" },
    creditor: { name: "Shop" },
  })], "acc", "user");
  const raw = row.raw as EbTransaction;
  assertEquals("creditor_account" in raw, false);
  assertEquals("debtor_account" in raw, false);
  assertEquals(raw.creditor, { name: "Shop" });
  assertEquals(raw.entry_reference, "r1");
});

Deno.test("own_counterparty: normalised IBAN match, other account false, no IBAN null", () => {
  const own = new Set([normalizeIban("IT60 X054 2811 1010 0000 0123 456")]);
  assertEquals(ownCounterparty(tx({ creditor_account: { iban: "it60x0542811101000000123456" } }), own), true);
  assertEquals(ownCounterparty(tx({ creditor_account: { iban: "DE89370400440532013000" } }), own), false);
  assertEquals(ownCounterparty(tx({ creditor_account: {} }), own), null);
  assertEquals(ownCounterparty(tx(), own), null);
  // A credit's counterparty is the debtor; the creditor is you.
  const credit = { credit_debit_indicator: "CRDT", creditor_account: { iban: "IT60X0542811101000000123456" } };
  assertEquals(ownCounterparty(tx({ ...credit, debtor_account: { iban: "DE89 3704 0044 0532 0130 00" } }), own), false);
  assertEquals(ownCounterparty(tx({ ...credit, debtor_account: { iban: "IT60X0542811101000000123456" } }), own), true);
  assertEquals(ownCounterparty(tx({ creditor_account: { iban: "IT60X0542811101000000123456" } })), null); // own IBANs unknown
});

Deno.test("buildRows keeps own_counterparty but not the IBAN", async () => {
  const [row] = await buildRows([tx({ creditor_account: { iban: "IT60X0542811101000000123456" } })], "acc", "user", new Set(["IT60X0542811101000000123456"]));
  assertEquals(row.own_counterparty, true);
  assertEquals("creditor_account" in (row.raw as object), false);
});

// protects=a sync re-run keeps the user's note and tags: the upsert only sets the columns its rows
// carry (the Edge Function sync runs this builder); fails_when=a row starts carrying note or tags
Deno.test("rows never carry note or tags", async () => {
  for (const own of [undefined, new Set<string>()]) {
    const [row] = await buildRows([tx()], "acc", "user", own);
    assertEquals("note" in row, false);
    assertEquals("tags" in row, false);
  }
});
