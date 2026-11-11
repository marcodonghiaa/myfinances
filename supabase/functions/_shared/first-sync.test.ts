import { assertEquals } from "jsr:@std/assert@1.0.19";
import { startFirstSync } from "./first-sync.ts";

type Call = { url: string; init: RequestInit };
const recorder = (status: number | Error) => {
  const calls: Call[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return status instanceof Error ? Promise.reject(status) : Promise.resolve(new Response("{}", { status }));
  }) as unknown as typeof fetch;
  return { calls, fn };
};

Deno.test("first sync: one sync-bank call per new account, with the secret key", async () => {
  const { calls, fn } = recorder(200);
  assertEquals(await startFirstSync("https://x.supabase.co/", "sb_secret_k", ["a1", "a2"], fn), 2);
  assertEquals(calls.map((c) => c.url), [
    "https://x.supabase.co/functions/v1/sync-bank",
    "https://x.supabase.co/functions/v1/sync-bank",
  ]);
  assertEquals((calls[0].init.headers as Record<string, string>).apikey, "sb_secret_k");
  assertEquals(JSON.parse(calls[1].init.body as string), { account_uid: "a2" });
});

Deno.test("first sync: no secret key, no call", async () => {
  const { calls, fn } = recorder(200);
  assertEquals(await startFirstSync("https://x", undefined, ["a1"], fn), 0);
  assertEquals(calls.length, 0);
});

Deno.test("first sync: a refused or failed call is counted, not thrown", async () => {
  const silence = console.error;
  console.error = () => {};
  try {
    assertEquals(await startFirstSync("https://x", "k", ["a1"], recorder(500).fn), 0);
    assertEquals(await startFirstSync("https://x", "k", ["a1"], recorder(new TypeError("net")).fn), 0);
  } finally {
    console.error = silence;
  }
});
