import { assertEquals } from "jsr:@std/assert@1";
import { mfaSatisfied } from "./mfa.ts";

const client = (data: unknown, error: unknown = null) => ({ rpc: () => Promise.resolve({ data, error }) });

Deno.test("mfaSatisfied passes only an explicit true", async () => {
  assertEquals(await mfaSatisfied(client(true)), true);
  assertEquals(await mfaSatisfied(client(false)), false);
  assertEquals(await mfaSatisfied(client(null)), false);
});

Deno.test("mfaSatisfied fails closed on an error", async () => {
  assertEquals(await mfaSatisfied(client(true, { message: "boom" })), false);
});
