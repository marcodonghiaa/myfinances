import { assertEquals } from "jsr:@std/assert@1.0.19";
import { retryRejectedToken } from "./postgrest-retry.ts";

// Answers with the queued responses in order; counts calls.
function fakeFetch(...responses: Array<[number, unknown]>) {
  let calls = 0;
  const fetch = (async () => {
    const [status, body] = responses[Math.min(calls++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

// protects=one refused minted token doesn't fail an account's sync; fails_when=PGRST303 isn't
// retried, or other errors (a real 401, a 500) get sent twice
Deno.test("retries once when PostgREST refuses the minted token", async () => {
  const f = fakeFetch([401, { code: "PGRST303", message: "JWT expired" }], [200, [{ uid: "a" }]]);
  const res = await retryRejectedToken(f.fetch)("http://x/rest/v1/accounts");
  assertEquals(res.status, 200);
  assertEquals(f.calls(), 2);
});

Deno.test("retries only once", async () => {
  const f = fakeFetch([401, { code: "PGRST303" }]);
  const res = await retryRejectedToken(f.fetch)("http://x");
  assertEquals(res.status, 401);
  assertEquals(f.calls(), 2);
});

Deno.test("leaves other answers alone", async () => {
  for (const [status, body] of [[200, []], [401, { code: "PGRST301" }], [401, "not json"], [500, { code: "PGRST303" }]] as Array<[number, unknown]>) {
    const f = fakeFetch([status, body]);
    const res = await retryRejectedToken(f.fetch)("http://x");
    assertEquals(res.status, status);
    assertEquals(f.calls(), 1, `${status} ${JSON.stringify(body)}`);
  }
});

Deno.test("the caller can still read a refused answer's body", async () => {
  const f = fakeFetch([401, { code: "PGRST301", message: "bad" }]);
  const res = await retryRejectedToken(f.fetch)("http://x");
  assertEquals((await res.json()).code, "PGRST301");
});
