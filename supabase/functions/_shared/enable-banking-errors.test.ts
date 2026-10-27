import { assertEquals } from "jsr:@std/assert@1";

// enable-banking.ts reads these at module load, so set them before importing it.
Deno.env.set("FRONTEND_URL", "https://x.test");
Deno.env.set("ENABLE_BANKING_APP_ID", "test-app");
Deno.env.set("ENABLE_BANKING_PRIVATE_KEY", "test-key");
const { ebErrorMessage, EB_KEY_INVALID, EB_NO_ACCOUNTS } = await import("./enable-banking.ts");

const REJECTED =
  "Your Enable Banking app was rejected: activate it (link one of your accounts on enablebanking.com → API applications), and check the key setup gave it.";
const GENERIC = "Enable Banking error, please try again";

Deno.test("ebErrorMessage explains a rejected app on 401/403", () => {
  assertEquals(ebErrorMessage(401), REJECTED);
  assertEquals(ebErrorMessage(403), REJECTED);
});

Deno.test("ebErrorMessage falls back to the generic copy", () => {
  assertEquals(ebErrorMessage(422), GENERIC);
  assertEquals(ebErrorMessage(500), GENERIC);
});

Deno.test("key and no-accounts copy", () => {
  assertEquals(EB_KEY_INVALID, "The Enable Banking key is invalid: run ./setup.sh again with the .pem.");
  assertEquals(
    EB_NO_ACCOUNTS,
    "Enable Banking didn't share any accounts. Link this bank once on enablebanking.com → API applications → your app → Link accounts, then try again.",
  );
});
