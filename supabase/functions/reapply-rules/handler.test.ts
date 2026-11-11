import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { reapplyHandler, retiredFrom, userIdFrom } from "./handler.ts";
import { memoryDb } from "../_shared/memory-db.test-helper.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const seed = (failWrite?: "update") =>
  memoryDb({
    transactions: [{ user_id: "u1", account_uid: "a1", entry_reference: "r1", creditor_name: "Bar Roma", remittance_info: "", category: "Others", category_source: "ai", deleted_at: null }],
    category_rules: [{ user_id: "u1", match_field: "creditor_name", match_text: "bar", match_mode: "word", set_category: "Dine Out", priority: 100, created_at: "2026-01-01" }],
  }, failWrite);
const call = async (
  db: ReturnType<typeof seed>,
  init: RequestInit & { headers?: Record<string, string> },
  mfa: { body: object; status: number } | null = null,
) => {
  const handler = reapplyHandler({
    userIdFor: (a) => Promise.resolve(a === "Bearer good" ? "u1" : null),
    mfaRefusal: () => Promise.resolve(mfa),
    admin: () => db,
  });
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

// Polish pass 2 #3: a failed write said only "Couldn't apply", though other rows may be saved.
Deno.test("a failed write is a 500 that says what was kept and that retrying is safe", async () => {
  const res = await call(seed("update"), { body: JSON.stringify({ apply: true }) });
  assertEquals(res.status, 500);
  assertEquals(res.body, {
    error: "Some transactions couldn't be updated. Try again: the ones already updated stay as they are.",
  });
});

Deno.test("a failed read keeps the plain error", async () => {
  const handler = reapplyHandler({ userIdFor: () => Promise.resolve("u1"), mfaRefusal: () => Promise.resolve(null), admin: () => ({ from: () => { throw new Error("down"); } }) });
  const res = await handler(new Request("http://x", { method: "POST", headers: { Authorization: "Bearer good" } }), json);
  assertEquals([res.status, await res.json()], [500, { error: "Couldn't apply your rules, please try again" }]);
});

// Polish pass 2 #4: when the auth server was down the user was told "Not signed in".
Deno.test("an auth server outage is a 503, not a sign-out", async () => {
  const handler = reapplyHandler({ userIdFor: () => Promise.reject(new Error("auth down")), mfaRefusal: () => Promise.resolve(null), admin: () => seed() });
  const res = await handler(new Request("http://x", { method: "POST", headers: { Authorization: "Bearer good" } }), json);
  assertEquals([res.status, await res.json()], [503, { error: "Sign-in check is unavailable, please try again" }]);
});

// Polish pass 2 re-audit: the auth-result check that tells "signed out" from "auth down".
Deno.test("userIdFrom: user id, null for a bad token, throws when auth is down", () => {
  assertEquals(userIdFrom({ data: { user: { id: "u1" } }, error: null }), "u1");
  for (const status of [400, 401, 403]) assertEquals(userIdFrom({ data: { user: null }, error: { status } }), null);
  for (const status of [0, 500, 503, undefined]) assertThrows(() => userIdFrom({ data: { user: null }, error: { status } }));
});

// Merge with two-step sign-in (#128): this function writes with the service key, which skips the
// database's MFA hook, so it must ask itself, like the other service-role functions.
Deno.test("refuses a session without the second step, before reading or writing", async () => {
  const db = seed();
  const res = await call(db, { body: JSON.stringify({ apply: true }) }, { body: { code: "mfa_required" }, status: 403 });
  assertEquals(res, { status: 403, body: { code: "mfa_required" } });
  assertEquals(db.tables.transactions[0].category, "Others");
});

Deno.test("retiredFrom: absent is undefined, a malformed rule is null, user_id never comes from the body", () => {
  assertEquals(retiredFrom({ apply: true }), undefined);
  assertEquals(retiredFrom(null), undefined);
  const good = { match_field: "any", match_text: "bar", match_mode: "word", set_category: "Dine Out", user_id: "u2" };
  assertEquals(retiredFrom({ retired: good }), { user_id: "", match_field: "any", match_text: "bar", match_mode: "word", set_category: "Dine Out" });
  assertEquals(retiredFrom({ retired: { ...good, match_mode: undefined } })?.match_mode, "contains");
  for (const bad of [
    "bar",
    { ...good, match_field: "category" },
    { ...good, match_text: 5 },
    { ...good, match_text: "x".repeat(2001) },
    { ...good, match_mode: "regex" },
    { ...good, set_category: "" },
    { ...good, set_category: null },
  ]) assertEquals(retiredFrom({ retired: bad }), null);
  assertEquals(retiredFrom({ retired: { ...good, match_text: "😀".repeat(200) } })?.match_text?.length, 400); // characters, not UTF-16 units
});

Deno.test("a malformed retired rule is a 400, nothing read", async () => {
  const db = seed();
  const tables: string[] = [];
  const watched = { ...db, from: (t: string) => (tables.push(t), db.from(t)) };
  const res = await call(watched, { body: JSON.stringify({ apply: true, retired: { match_field: "x" } }) });
  assertEquals(res, { status: 400, body: { error: "That rule can't be checked" } });
  assertEquals(tables, []); // polish 1 #11: the name promised this, the test didn't check it
});

Deno.test("retired rule: scoped to the caller even if the body names another user", async () => {
  const db = memoryDb({
    transactions: [
      { user_id: "u1", account_uid: "a1", entry_reference: "r1", creditor_name: "BARCLAYS", remittance_info: "", category: "Dine Out", category_source: "rule", deleted_at: null },
      { user_id: "u2", account_uid: "a2", entry_reference: "r2", creditor_name: "BARCLAYS", remittance_info: "", category: "Dine Out", category_source: "rule", deleted_at: null },
    ],
    category_rules: [],
  });
  const retired = { user_id: "u2", match_field: "creditor_name", match_text: "bar", match_mode: "contains", set_category: "Dine Out" };
  const res = await call(db, { body: JSON.stringify({ apply: true, retired }) });
  assertEquals(res.body.changes, 1);
  assertEquals(db.tables.transactions.map((r) => r.category), [null, "Dine Out"]);
});

// Polish 1 #6: rules from before the 200-character cap are still in the table; deleting one must
// still be able to re-sort what it filed. The body stays bounded.
Deno.test("retiredFrom: takes a pre-cap rule longer than 200 characters", () => {
  const good = { match_field: "any", match_text: "x".repeat(201), match_mode: "contains", set_category: "Dine Out" };
  assertEquals(retiredFrom({ retired: good })?.match_text, "x".repeat(201));
  assertEquals(retiredFrom({ retired: { ...good, match_text: "x".repeat(2000) } })?.match_text?.length, 2000);
});

// Polish 1 #9: the category is counted in characters like the text, not UTF-16 units.
Deno.test("retiredFrom: a category is bounded in characters", () => {
  const good = { match_field: "any", match_text: "bar", match_mode: "word", set_category: "😀".repeat(2000) };
  assertEquals(retiredFrom({ retired: good })?.set_category, "😀".repeat(2000));
  assertEquals(retiredFrom({ retired: { ...good, set_category: "x".repeat(2001) } }), null);
});

// Polish 2 #3: the body is a few hundred bytes; a huge one is refused before it's parsed.
Deno.test("a body over 16 KB is a 413, nothing read", async () => {
  const db = seed();
  const tables: string[] = [];
  const watched = { ...db, from: (t: string) => (tables.push(t), db.from(t)) };
  const big = JSON.stringify({ apply: true, pad: "x".repeat(17 * 1024) });
  assertEquals(await call(watched, { body: big }), { status: 413, body: { error: "Request too large" } });
  assertEquals(tables, []);
});

// Polish 2 #4: a failing two-step check is a 503 like a failing sign-in check, not a crash.
Deno.test("the two-step check failing is a 503, nothing read", async () => {
  const db = seed();
  const tables: string[] = [];
  const handler = reapplyHandler({
    userIdFor: () => Promise.resolve("u1"),
    mfaRefusal: () => Promise.reject(new Error("auth down")),
    admin: () => ({ ...db, from: (t: string) => (tables.push(t), db.from(t)) }),
  });
  const res = await handler(new Request("http://x/reapply-rules", { method: "POST", headers: { Authorization: "Bearer good" }, body: "{}" }), json);
  assertEquals([res.status, await res.json()], [503, { error: "Sign-in check is unavailable, please try again" }]);
  assertEquals(tables, []);
});

Deno.test("a Content-Length over 16 KB is refused before the body is read", async () => {
  const res = await call(seed(), { headers: { Authorization: "Bearer good", "Content-Length": String(17 * 1024) }, body: "{}" });
  assertEquals(res, { status: 413, body: { error: "Request too large" } });
});
