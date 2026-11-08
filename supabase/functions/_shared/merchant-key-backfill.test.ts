import { assertEquals } from "jsr:@std/assert@1";
import { fillMerchantKeys } from "./merchant-key-backfill.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const tx = (ref: string, creditor: string, over: Record<string, unknown> = {}) => ({
  user_id: "u1", account_uid: "a1", entry_reference: ref, creditor_name: creditor,
  merchant_key: null, custom_name: null, ...over,
});
const alias = (source: string, name: string, created: string, over: Record<string, unknown> = {}) => ({
  user_id: "u1", source_name: source, alias: name, merchant_key: null, created_at: created, ...over,
});
const always = () => true;
const byRef = (db: ReturnType<typeof memoryDb>, ref: string) => db.tables.transactions.find((r) => r.entry_reference === ref)!;

Deno.test("fills keys for rows without one", async () => {
  const db = memoryDb({ transactions: [tx("r1", "Lidl 4521"), tx("r2", "LIDL 4521 MILANO IT")], merchant_aliases: [] });
  const result = await fillMerchantKeys(db, always);
  assertEquals([byRef(db, "r1").merchant_key, byRef(db, "r2").merchant_key], ["lidl", "lidl"]);
  assertEquals(result.keys, 2);
});

Deno.test("applies an existing alias to a newly keyed row", async () => {
  const db = memoryDb({
    transactions: [tx("r1", "LIDL 4521 MILANO IT"), tx("named", "Lidl 4521", { custom_name: "Mine" })],
    merchant_aliases: [alias("Lidl 4521", "Lidl", "2026-01-01", { merchant_key: "lidl" })],
  });
  await fillMerchantKeys(db, always);
  assertEquals(byRef(db, "r1").custom_name, "Lidl");
  assertEquals([byRef(db, "named").custom_name, byRef(db, "named").merchant_key], ["Mine", "lidl"]);
});

Deno.test("dedupes aliases that collapse to one key, newest wins", async () => {
  const db = memoryDb({
    transactions: [],
    merchant_aliases: [alias("Lidl 4521", "Supermarket", "2026-01-01"), alias("LIDL 4521 MILANO IT", "Lidl", "2026-06-01")],
  });
  await fillMerchantKeys(db, always);
  assertEquals(db.tables.merchant_aliases.map((a) => [a.alias, a.merchant_key]), [["Lidl", "lidl"]]);
});

Deno.test("same created_at: the first source_name wins, like the SQL", async () => {
  const db = memoryDb({
    transactions: [],
    merchant_aliases: [alias("Lidl 4521 Milano IT", "Second", "2026-01-01"), alias("Lidl 4521", "First", "2026-01-01")],
  });
  await fillMerchantKeys(db, always);
  assertEquals(db.tables.merchant_aliases.map((a) => a.alias), ["First"]);
});

Deno.test("a PayPal row does not get another PayPal payee's alias", async () => {
  const db = memoryDb({
    transactions: [tx("pp", "PAYPAL *P1A2B3C4D5")],
    merchant_aliases: [alias("PAYPAL *P9F8E7D6C5", "Gym", "2026-01-01")],
  });
  await fillMerchantKeys(db, always);
  assertEquals([byRef(db, "pp").merchant_key, byRef(db, "pp").custom_name], ["paypal", null]);
});

Deno.test("two PayPal-source aliases both survive, unkeyed", async () => {
  const db = memoryDb({
    transactions: [],
    merchant_aliases: [alias("PAYPAL *P1A2B3C4D5", "Gym", "2026-01-01"), alias("PAYPAL *P9F8E7D6C5", "Club", "2026-06-01")],
  });
  await fillMerchantKeys(db, always);
  assertEquals(db.tables.merchant_aliases.map((a) => [a.alias, a.merchant_key]), [["Gym", null], ["Club", null]]);
});

Deno.test("stops when time is up", async () => {
  const db = memoryDb({ transactions: [tx("r1", "Lidl 4521")], merchant_aliases: [alias("Lidl 4521", "Lidl", "2026-01-01")] });
  assertEquals(await fillMerchantKeys(db, () => false), { keys: 0, aliases: 0 });
  assertEquals([byRef(db, "r1").merchant_key, db.tables.merchant_aliases[0].merchant_key], [null, null]);
});

// protects=blank names never block the backfill; fails_when=rows without a possible key are refetched ahead of real ones
Deno.test("blank names are skipped, so they never starve real rows", async () => {
  const db = memoryDb({ transactions: [tx("a1", ""), tx("a2", "   "), tx("z", "Lidl 4521")], merchant_aliases: [] });
  assertEquals(await fillMerchantKeys(db, always, 1), { keys: 1, aliases: 0 });
  assertEquals(byRef(db, "z").merchant_key, "lidl");
});

// protects=a failing first step never takes down categorize and flows; fails_when=a select error throws out of post-sync
Deno.test("a read error logs and returns zeros instead of throwing", async () => {
  const errors = console.error;
  const logged: string[] = [];
  console.error = (m: string) => void logged.push(m);
  const failing = { from: () => ({ select: () => ({ order: () => ({ order: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) };
  try {
    assertEquals(await fillMerchantKeys(failing, always), { keys: 0, aliases: 0 });
    assertEquals(logged.length, 1);
  } finally {
    console.error = errors;
  }
});

// protects=a failed alias write is logged by code only and never aborts; fails_when=the message (names) leaks or the step throws
async function logsOf(run: () => Promise<unknown>): Promise<string[]> {
  const errors = console.error;
  const logged: string[] = [];
  console.error = (m: string) => void logged.push(m);
  try {
    await run();
  } finally {
    console.error = errors;
  }
  return logged;
}

Deno.test("a failed duplicate-alias delete logs the count and code only", async () => {
  const db = memoryDb({
    transactions: [],
    merchant_aliases: [alias("Lidl 4521", "A", "2026-01-01"), alias("LIDL 4521 MILANO IT", "B", "2026-06-01")],
  }, "delete");
  assertEquals(await logsOf(() => fillMerchantKeys(db, always)), ["Failed to remove 1 duplicate alias(es): XX000"]);
});

Deno.test("a failed alias key update logs the code only", async () => {
  const db = memoryDb({ transactions: [], merchant_aliases: [alias("Lidl 4521", "A", "2026-01-01")] }, "update");
  assertEquals(await logsOf(() => fillMerchantKeys(db, always)), ["Failed to key an alias: XX000"]);
});
