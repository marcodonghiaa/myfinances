import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fetchBatchForOneUser, walkNullRows } from "./user-batch.ts";
import { memoryDb } from "./memory-db.test-helper.ts";

const row = (user_id: string, ref: string) => ({ user_id, account_uid: "a", entry_reference: ref, category: null });
const opts = { select: "entry_reference", nullColumn: "category", limit: 40 };

Deno.test("returns rows from a single user, within the limit, skipping excluded users", async () => {
  const db = memoryDb({ transactions: [row("a", "1"), row("b", "2"), row("a", "3"), row("b", "4")] });
  const batch = await fetchBatchForOneUser(db, opts);
  assertEquals(new Set(batch.map((r) => r.user_id)).size, 1);
  assertEquals((await fetchBatchForOneUser(db, { ...opts, limit: 1 })).length, 1);
  assertEquals((await fetchBatchForOneUser(db, { ...opts, excludeUserIds: new Set(["a"]) })).map((r) => r.user_id), ["b", "b"]);
  assertEquals(await fetchBatchForOneUser(db, { ...opts, excludeUserIds: new Set(["a", "b"]) }), []);
  assertEquals(await fetchBatchForOneUser(memoryDb({ transactions: [] }), opts), []);
});

Deno.test("throws when the query fails", async () => {
  const failing = { from: () => ({ select: () => ({ is: () => ({ limit: () => Promise.resolve({ data: null, error: new Error("boom") }) }) }) }) };
  await assertRejects(() => fetchBatchForOneUser(failing, opts), Error, "boom");
});

Deno.test("walkNullRows reaches every row even when filled rows drop out between pages", async () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const rows = names.map((n, i) => ({ account_uid: "x", entry_reference: n, category: null as string | null, fill: i % 2 === 0 }));
  const db = memoryDb({ transactions: rows });
  const seen: string[] = [];
  const filled = await walkNullRows(db, {
    select: "*",
    nullColumn: "category",
    pageSize: 2,
    handlePage: async (page) => {
      seen.push(...page.map((r) => r.entry_reference));
      const toFill = page.filter((r) => r.fill);
      for (const r of toFill) rows.find((x) => x.entry_reference === r.entry_reference)!.category = "X";
      return toFill.length;
    },
  });
  assertEquals(filled, 4);
  assertEquals(seen, names);
});

Deno.test("walkNullRows stops paging once the time is up", async () => {
  const rows = ["a", "b", "c", "d"].map((n) => ({ account_uid: "x", entry_reference: n, category: null }));
  let pages = 0;
  let checks = 0;
  const filled = await walkNullRows(memoryDb({ transactions: rows }), {
    select: "*", nullColumn: "category", pageSize: 1, timeLeft: () => checks++ < 2,
    handlePage: async () => (pages++, 0),
  });
  assertEquals([pages, filled], [2, 0]);
});
