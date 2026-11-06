import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyGroupedUpdates, type RowUpdate } from "./batch-update.ts";

type Call = {
  table: string;
  update: Record<string, unknown> | null;
  eq: Record<string, unknown>;
  in: { col: string; vals: string[] } | null;
  guardIn?: { col: string; vals: string[] };
  is: { col: string; val: unknown } | null;
};

// Records each UPDATE the way PostgREST would see it: one call per statement.
function fakeDb({ failWhen }: { failWhen?: (c: Call) => boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, update: null, eq: {}, in: null, is: null };
      const q = {
        update(u: Record<string, unknown>) { call.update = u; return q; },
        eq(col: string, val: unknown) { call.eq[col] = val; return q; },
        in(col: string, vals: string[]) {
          if (col === "entry_reference") call.in = { col, vals };
          else call.guardIn = { col, vals };
          return q;
        },
        is(col: string, val: unknown) { call.is = { col, val }; return q; },
        then(resolve: (v: unknown) => void) {
          calls.push(call);
          resolve({ error: failWhen?.(call) ? { code: "42501", message: "boom" } : null });
        },
      };
      return q;
    },
  };
}

const item = (ref: string, over: Partial<RowUpdate> = {}): RowUpdate => ({
  account_uid: "acc1",
  entry_reference: ref,
  update: { category: "Groceries" },
  guardColumn: "category",
  ...over,
});

Deno.test("rows with the same account and update become one statement", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [item("1"), item("2"), item("3")]);
  assertEquals(db.calls.length, 1);
  assertEquals(db.calls[0].in, { col: "entry_reference", vals: ["1", "2", "3"] });
  assertEquals(db.calls[0].update, { category: "Groceries" });
  assertEquals(db.calls[0].eq.account_uid, "acc1");
});

Deno.test("only fills empty values: every statement carries the is-null guard", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [item("1")]);
  assertEquals(db.calls[0].is, { col: "category", val: null });
});

Deno.test("different values or accounts are separate statements", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [item("1"), item("2", { update: { category: "Health" } }), item("3", { account_uid: "acc2" })]);
  assertEquals(db.calls.length, 3);
});

Deno.test("large groups are chunked so the request URL stays short", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, Array.from({ length: 120 }, (_, i) => item(String(i))));
  assertEquals(db.calls.map((c) => c.in!.vals.length), [50, 50, 20]);
});

Deno.test("a failed statement is logged by code, never by message, and the others still run", async () => {
  const db = fakeDb({ failWhen: (c) => c.update?.category === "Health" });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    await applyGroupedUpdates(db, [item("1", { update: { category: "Health" } }), item("2")]);
  } finally {
    console.error = original;
  }
  assertEquals(db.calls.length, 2);
  assert(logged.some((l) => l.includes("42501")));
  assert(!logged.some((l) => l.includes("boom")));
});

Deno.test("does nothing for an empty list", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, []);
  assertEquals(db.calls.length, 0);
});

Deno.test("guardIn items are guarded by an in-list instead of is-null", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [
    item("1", { update: { category: "Health", category_source: "rule" }, guardColumn: "category_source", guardIn: ["ai", "rule"] }),
  ]);
  assertEquals(db.calls[0].is, null);
  assertEquals(db.calls[0].guardIn, { col: "category_source", vals: ["ai", "rule"] });
});
