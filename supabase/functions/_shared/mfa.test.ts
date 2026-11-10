import { assertEquals } from "jsr:@std/assert@1";
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
