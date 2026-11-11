import { assertEquals } from "jsr:@std/assert@1.0.19";
import { mfaRefusal } from "./mfa.ts";

const client = (data: unknown, error: { code?: string; message?: string } | null = null) => ({
  rpc: () => Promise.resolve({ data, error }),
});

Deno.test("mfaRefusal lets only an explicit true through", async () => {
  assertEquals(await mfaRefusal(client(true)), null);
  assertEquals((await mfaRefusal(client(false)))?.status, 403);
  assertEquals((await mfaRefusal(client(null)))?.status, 403);
});

Deno.test("mfaRefusal: database refuses the session → 403 mfa_required", async () => {
  const r = await mfaRefusal(client(null, { code: "42501", message: "Enter your authenticator code first" }));
  assertEquals(r?.status, 403);
  assertEquals((r?.body as { code: string }).code, "mfa_required");
});

Deno.test("mfaRefusal: any other error → 503, still refused", async () => {
  const r = await mfaRefusal(client(true, { code: "PGRST202", message: "missing" }));
  assertEquals(r?.status, 503);
});

// protects=the repo rule "log a tag, never the message" (log-safe.ts);
// fails_when=a database error's text, which can carry personal data, reaches the logs
Deno.test("mfaRefusal logs the error code, never its message", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await mfaRefusal(client(null, { code: "PGRST202", message: "for jane@example.com" }));
  } finally {
    console.error = original;
  }
  const text = JSON.stringify(logged);
  assertEquals(text.includes("PGRST202"), true);
  assertEquals(text.includes("jane@example.com"), false);
});
