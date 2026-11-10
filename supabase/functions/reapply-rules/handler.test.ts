import { assertEquals } from "jsr:@std/assert@1";
import { reapplyHandler } from "./handler.ts";
import { memoryDb } from "../_shared/memory-db.test-helper.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const seed = (failWrite?: "update") =>
  memoryDb({
    transactions: [{ user_id: "u1", account_uid: "a1", entry_reference: "r1", creditor_name: "Bar Roma", remittance_info: "", category: "Others", category_source: "ai", deleted_at: null }],
    category_rules: [{ user_id: "u1", match_field: "creditor_name", match_text: "bar", match_mode: "word", set_category: "Dine Out", priority: 100, created_at: "2026-01-01" }],
  }, failWrite);
const call = async (db: ReturnType<typeof seed>, init: RequestInit & { headers?: Record<string, string> }) => {
  const handler = reapplyHandler({ userIdFor: (a) => Promise.resolve(a === "Bearer good" ? "u1" : null), admin: () => db });
  const res = await handler(new Request("http://x/reapply-rules", { method: "POST", headers: { Authorization: "Bearer good" }, ...init }), json);
  return { status: res.status, body: await res.json() };
};

Deno.test("only POST", async () => {
  assertEquals((await call(seed(), { method: "GET" })).status, 405);
});

Deno.test("no or bad token: 401, nothing read", async () => {
  assertEquals((await call(seed(), { headers: {} })).status, 401);
  assertEquals((await call(seed(), { headers: { Authorization: "Bearer bad" } })).status, 401);
});

Deno.test("a body that isn't { apply: true } only previews", async () => {
  const db = seed();
  const res = await call(db, { body: "not json" });
  assertEquals(res, { status: 200, body: { changes: 1, sample: [{ name: "Bar Roma", from: "Others", to: "Dine Out" }] } });
  assertEquals(db.tables.transactions[0].category, "Others");
});

Deno.test("apply writes, as a rule", async () => {
  const db = seed();
  assertEquals((await call(db, { body: JSON.stringify({ apply: true }) })).body.changes, 1);
  assertEquals(db.tables.transactions[0].category_source, "rule");
});

Deno.test("a failed write is a 500, not a silent success", async () => {
  const res = await call(seed("update"), { body: JSON.stringify({ apply: true }) });
  assertEquals(res.status, 500);
  assertEquals(res.body, { error: "Couldn't apply your rules, please try again" });
});
