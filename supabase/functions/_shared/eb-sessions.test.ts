import { assertEquals } from "jsr:@std/assert@1";
import { burnCode, closeSessions } from "./eb-sessions.ts";

const sign = () => Promise.resolve("jwt");
const quiet = async (fn: () => Promise<void>) => {
  const original = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = original;
  }
};
const replies = (...results: Array<number | Error | [number, unknown]>) => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fn = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method });
    const r = results[calls.length - 1];
    if (r instanceof Error) return Promise.reject(r);
    const [status, body] = Array.isArray(r) ? r : [r, {}];
    return Promise.resolve(Response.json(body, { status }));
  }) as unknown as typeof fetch;
  return { calls, fn };
};

Deno.test("closeSessions: closed and already-gone (404) count, failures don't stop the rest", async () => {
  const { calls, fn } = replies(200, 404, 500, new TypeError("net"));
  await quiet(async () => {
    assertEquals(await closeSessions(["a", "b", "c", "d/e"], fn, sign), 2);
  });
  assertEquals(calls.map((c) => c.method), ["DELETE", "DELETE", "DELETE", "DELETE"]);
  assertEquals(calls[3].url, "https://api.enablebanking.com/sessions/d%2Fe");
});

Deno.test("closeSessions: nothing to close, no bank call", async () => {
  const { calls, fn } = replies();
  assertEquals(await closeSessions([], fn, sign), 0);
  assertEquals(calls.length, 0);
});

Deno.test("burnCode: exchanges the code, then closes the session it opened", async () => {
  const { calls, fn } = replies([200, { session_id: "s1" }], 200);
  await burnCode("code", fn, sign);
  assertEquals(calls, [
    { url: "https://api.enablebanking.com/sessions", method: "POST" },
    { url: "https://api.enablebanking.com/sessions/s1", method: "DELETE" },
  ]);
});

Deno.test("burnCode: a refused code opens nothing to close, and errors are swallowed", async () => {
  const refused = replies([400, { error: "bad" }]);
  await burnCode("code", refused.fn, sign);
  assertEquals(refused.calls.length, 1);
  await quiet(() => burnCode("code", replies(new TypeError("net")).fn, sign));
});
