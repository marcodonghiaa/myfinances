import { assertEquals } from "jsr:@std/assert@1";
import { corsHeaders, pickAllowedOrigin, pickRedirectOrigin, redirectOrigin, serveWithCors } from "./origins.ts";

const A = "https://a.example.com";
const B = "http://localhost:3000";

function withLegacy<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  if (value === undefined) Deno.env.delete("FRONTEND_URL");
  else Deno.env.set("FRONTEND_URL", value);
  return run().finally(() => Deno.env.delete("FRONTEND_URL"));
}

Deno.test("pickAllowedOrigin only echoes an allowed origin", () => {
  assertEquals(pickAllowedOrigin(A, [A, B]), A);
  assertEquals(pickAllowedOrigin("https://evil.example.com", [A, B]), null);
  assertEquals(pickAllowedOrigin(null, [A, B]), null);
  assertEquals(pickAllowedOrigin(A + "/", [A]), null);
});

Deno.test("pickRedirectOrigin prefers the stored origin, then the legacy secret, then the first registered", () => {
  assertEquals(pickRedirectOrigin(B, [A, B], "https://old.example.com"), B);
  assertEquals(pickRedirectOrigin("https://gone.example.com", [A, B], "https://old.example.com"), "https://old.example.com");
  assertEquals(pickRedirectOrigin(null, [A, B], null), A);
  assertEquals(pickRedirectOrigin(null, [], null), null);
});

Deno.test("redirectOrigin ignores a stored origin that is no longer allowed", async () => {
  await withLegacy(undefined, async () => {
    assertEquals(await redirectOrigin("https://evil.example.com", async () => [A]), A);
  });
});

Deno.test("corsHeaders sets Allow-Origin only for an allowed origin and always Vary", () => {
  assertEquals(corsHeaders(A)["Access-Control-Allow-Origin"], A);
  assertEquals("Access-Control-Allow-Origin" in corsHeaders(null), false);
  assertEquals(corsHeaders(null).Vary, "Origin");
});

Deno.test("preflight from a registered origin gets 204 and that origin", async () => {
  await withLegacy(undefined, async () => {
    const serve = serveWithCors(async (_req, reply) => reply({ ok: true }), async () => [A]);
    const res = await serve(new Request("https://f.test/x", { method: "OPTIONS", headers: { Origin: A } }));
    assertEquals(res.status, 204);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), A);
    assertEquals(res.headers.get("Vary"), "Origin");
  });
});

Deno.test("an unknown origin gets no Allow-Origin header", async () => {
  await withLegacy(undefined, async () => {
    const serve = serveWithCors(async (_req, reply) => reply({ ok: true }), async () => [A]);
    const res = await serve(new Request("https://f.test/x", { method: "POST", headers: { Origin: "https://evil.example.com" } }));
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), null);
    assertEquals(await res.json(), { ok: true });
  });
});

Deno.test("the legacy FRONTEND_URL secret is still allowed, trailing slash stripped, with an empty table", async () => {
  await withLegacy("https://old.example.com/", async () => {
    const serve = serveWithCors(async (_req, reply, origin) => reply({ origin }), async () => []);
    const res = await serve(new Request("https://f.test/x", { method: "POST", headers: { Origin: "https://old.example.com" } }));
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://old.example.com");
    assertEquals(await res.json(), { origin: "https://old.example.com" });
  });
});

Deno.test("a failed lookup falls back to the legacy secret and does not throw", async () => {
  await withLegacy("https://old.example.com", async () => {
    const serve = serveWithCors(async (_req, reply) => reply({}), async () => { throw new Error("relation missing"); });
    const ok = await serve(new Request("https://f.test/x", { method: "POST", headers: { Origin: "https://old.example.com" } }));
    assertEquals(ok.headers.get("Access-Control-Allow-Origin"), "https://old.example.com");
    const other = await serve(new Request("https://f.test/x", { method: "POST", headers: { Origin: A } }));
    assertEquals(other.headers.get("Access-Control-Allow-Origin"), null);
  });
});

Deno.test("reply carries the status and a JSON body", async () => {
  await withLegacy(undefined, async () => {
    const serve = serveWithCors(async (_req, reply) => reply({ error: "no" }, 401), async () => []);
    const res = await serve(new Request("https://f.test/x", { method: "POST" }));
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("Content-Type"), "application/json");
  });
});
