import { assertEquals } from "jsr:@std/assert@1.0.19";
import { matchTransferPairs, pairKey, type PairRow, pairTransfers } from "./transfer-pairs.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const day = (offset: number) => new Date(Date.now() - (10 - offset) * 86_400_000).toISOString().slice(0, 10);
const out = (ref: string, offset = 0, over: Partial<PairRow> = {}): PairRow => ({
  user_id: "u1", account_uid: "checking", entry_reference: ref, amount: 500, currency: "EUR",
  credit_debit_indicator: "DBIT", booking_date: day(offset), ...over,
});
const inn = (ref: string, offset = 0, over: Partial<PairRow> = {}) =>
  out(ref, offset, { account_uid: "savings", credit_debit_indicator: "CRDT", ...over });
const refs = (pairs: ReturnType<typeof matchTransferPairs>) => pairs.map((p) => [p.out.entry_reference, p.in.entry_reference]);

Deno.test("pairs an exact debit and credit on two accounts", () => {
  assertEquals(refs(matchTransferPairs([out("o"), inn("i")])), [["o", "i"]]);
});

Deno.test("pairs within 4 days, not 5", () => {
  assertEquals(refs(matchTransferPairs([out("o"), inn("i", 4)])), [["o", "i"]]);
  assertEquals(refs(matchTransferPairs([out("o"), inn("i", 5)])), []);
});

Deno.test("no pair across users, on the same account, in another currency or amount, or the same direction", () => {
  assertEquals(refs(matchTransferPairs([out("o"), inn("i", 0, { user_id: "u2" })])), []);
  assertEquals(refs(matchTransferPairs([out("o"), inn("i", 0, { account_uid: "checking" })])), []);
  assertEquals(refs(matchTransferPairs([out("o"), inn("i", 0, { currency: "USD" })])), []);
  assertEquals(refs(matchTransferPairs([out("o"), inn("i", 0, { amount: 500.01 })])), []);
  assertEquals(refs(matchTransferPairs([out("o"), out("o2", 0, { account_uid: "savings" })])), []);
});

// protects=better no pair than a wrong one; fails_when=a tie picks one side at random
Deno.test("a tie pairs nothing", () => {
  assertEquals(refs(matchTransferPairs([out("o", 2), inn("i1", 1), inn("i2", 3)])), []);
  assertEquals(refs(matchTransferPairs([out("o1", 1), out("o2", 3), inn("i", 2)])), []);
});

Deno.test("one-to-one: the closest date wins and the other rows pair among themselves", () => {
  const rows = [out("o1", 0), out("o2", 3), inn("i1", 1), inn("i2", 4)];
  assertEquals(refs(matchTransferPairs(rows)), [["o1", "i1"], ["o2", "i2"]]);
  assertEquals(refs(matchTransferPairs([out("o1", 0), out("o2", 1), inn("i", 1)])), [["o2", "i"]]);
});

Deno.test("a pair you rejected is never proposed again", () => {
  const o = out("o"), i = inn("i");
  assertEquals(refs(matchTransferPairs([o, i], new Set([pairKey(o, i)]))), []);
});

// protects=only machine-decided flows are paired, and a pair marks both sides; fails_when=a row you
// decided, a deleted one or one already paired becomes a suggested transfer
Deno.test("two bank sides are not paired (both already transfers)", () => {
  assertEquals(refs(matchTransferPairs([out("o", 0, { flow_source: "bank" }), inn("i", 0, { flow_source: "bank" })])), []);
  assertEquals(refs(matchTransferPairs([out("o", 0, { flow_source: "bank" }), inn("i", 0, { flow_source: "default" })])), [["o", "i"]]);
});

// protects=a suggestion never outlives its rows (F); fails_when=a pair whose row you edited, or
// whose update never landed, stays suggested, or its leftover 'pair' side stays a transfer
Deno.test("pairTransfers removes suggested pairs whose rows changed and frees the leftover side", async () => {
  const db = memoryDb({
    transfer_pairs: [
      { id: "edited", out_account_uid: "checking", out_ref: "eo", in_account_uid: "savings", in_ref: "ei", status: "suggested" },
      { id: "unmarked", out_account_uid: "checking", out_ref: "uo", in_account_uid: "savings", in_ref: "ui", status: "suggested" },
      { id: "ok", out_account_uid: "checking", out_ref: "ko", in_account_uid: "savings", in_ref: "ki", status: "suggested" },
      { id: "done", out_account_uid: "checking", out_ref: "do", in_account_uid: "savings", in_ref: "di", status: "confirmed" },
    ],
    transactions: [
      { ...out("eo", 0, { amount: 1 }), flow_type: "transfer", flow_source: "pair", deleted_at: null },
      { ...inn("ei", 0, { amount: 1 }), flow_type: "income", flow_source: "user", deleted_at: null },
      { ...out("uo", 0, { amount: 2 }), flow_type: "spend", flow_source: "default", deleted_at: "2026-11-01" },
      { ...inn("ui", 0, { amount: 2 }), flow_type: "transfer", flow_source: "pair", deleted_at: null },
      { ...out("ko", 0, { amount: 3 }), flow_type: "transfer", flow_source: "pair", deleted_at: null },
      { ...inn("ki", 0, { amount: 3 }), flow_type: "transfer", flow_source: "bank", deleted_at: null },
      { ...out("do", 0, { amount: 4 }), flow_type: "transfer", flow_source: "user", deleted_at: null },
      { ...inn("di", 0, { amount: 4 }), flow_type: "transfer", flow_source: "user", deleted_at: null },
    ],
  });
  assertEquals(await pairTransfers(db), 0);
  assertEquals(db.tables.transfer_pairs.map((p) => p.id), ["ok", "done"]);
  const flow = (ref: string) => db.tables.transactions.find((r) => r.entry_reference === ref)!;
  assertEquals([flow("eo").flow_type, flow("eo").flow_source], ["spend", "default"]);
  assertEquals([flow("ui").flow_type, flow("ui").flow_source], ["income", "default"]);
  assertEquals([flow("ei").flow_type, flow("ei").flow_source], ["income", "user"]);
});

Deno.test("pairTransfers suggests the pair and marks both rows, skipping locked and paired rows", async () => {
  const row = (r: PairRow, over = {}) => ({ ...r, flow_type: r.credit_debit_indicator === "DBIT" ? "spend" : "income", flow_source: "default", deleted_at: null, ...over });
  const db = memoryDb({
    transfer_pairs: [
      { id: "p0", out_account_uid: "checking", out_ref: "old-o", in_account_uid: "savings", in_ref: "old-i", status: "suggested" },
      { id: "p1", out_account_uid: "checking", out_ref: "rej-o", in_account_uid: "savings", in_ref: "rej-i", status: "rejected" },
    ],
    transactions: [
      row(out("o", 0)),
      row(inn("i", 1), { flow_type: "transfer", flow_source: "bank" }),
      row(out("mine", 0, { amount: 70 }), { flow_source: "user" }),
      row(out("hist", 0, { amount: 75 }), { flow_source: "legacy" }),
      row(inn("hist-i", 0, { amount: 75 })),
      row(inn("mine-i", 0, { amount: 70 })),
      row(out("gone", 0, { amount: 80 }), { deleted_at: "2026-11-01" }),
      row(inn("gone-i", 0, { amount: 80 })),
      row(out("old-o", 0, { amount: 90 }), { flow_type: "transfer", flow_source: "pair" }),
      row(inn("old-i", 0, { amount: 90 }), { flow_type: "transfer", flow_source: "pair" }),
      row(inn("old-i2", 0, { amount: 90 })),
      row(out("rej-o", 0, { amount: 60 })),
      row(inn("rej-i", 0, { amount: 60 })),
    ],
  });
  assertEquals(await pairTransfers(db), 1);
  const pair = db.tables.transfer_pairs[2];
  assertEquals([pair.user_id, pair.out_ref, pair.in_ref, pair.status], ["u1", "o", "i", "suggested"]);
  const flows = db.tables.transactions.filter((r) => r.flow_type === "transfer").map((r) => [r.entry_reference, r.flow_source]);
  // The bank side was already a transfer and keeps its source; only the default side changes.
  assertEquals(flows, [["o", "pair"], ["i", "bank"], ["old-o", "pair"], ["old-i", "pair"]]);
  assertEquals(db.tables.transfer_pairs.length, 3);
});

Deno.test("pairTransfers does nothing once the time is up", async () => {
  const db = memoryDb({ transactions: [] });
  assertEquals(await pairTransfers(db, () => false), 0);
});
