import { assertEquals } from "jsr:@std/assert@1";
import { mfaSatisfied } from "./mfa.ts";

const client = (data: unknown, error: { code?: string; message?: string } | null = null) => ({
  rpc: () => Promise.resolve({ data, error }),
});

Deno.test("mfaSatisfied passes only an explicit true", async () => {
  assertEquals(await mfaSatisfied(client(true)), true);
  assertEquals(await mfaSatisfied(client(false)), false);
  assertEquals(await mfaSatisfied(client(null)), false);
});

Deno.test("mfaSatisfied fails closed when the database refuses the session", async () => {
  assertEquals(await mfaSatisfied(client(null, { code: "42501", message: "Enter your authenticator code first" })), false);
});

Deno.test("mfaSatisfied fails closed on any other error", async () => {
  assertEquals(await mfaSatisfied(client(true, { code: "PGRST202", message: "missing" })), false);
});
