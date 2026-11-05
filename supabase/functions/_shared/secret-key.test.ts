import { assertEquals } from "jsr:@std/assert@1";
import { hasSecretKey, parseSecretKeys } from "./secret-key.ts";

const KEYS = parseSecretKeys(JSON.stringify({ default: "sb_secret_abc", cron: "sb_secret_xyz" }));
const req = (headers: Record<string, string> = {}) => new Request("http://x", { headers });
const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const serviceRoleJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.sig`;

// protects=only our own backend can spend the bank's daily calls; fails_when=a missing, wrong or
// forged credential (an unverified service_role JWT, the key in Authorization) gets in
Deno.test("hasSecretKey accepts any of the project's secret keys on apikey", () => {
  assertEquals(hasSecretKey(req({ apikey: "sb_secret_abc" }), KEYS), true);
  assertEquals(hasSecretKey(req({ apikey: "sb_secret_xyz" }), KEYS), true);
});

Deno.test("hasSecretKey rejects a wrong, missing or misplaced key", () => {
  const cases: Array<Record<string, string>> = [
    {},
    { apikey: "" },
    { apikey: "sb_secret_ab" },
    { apikey: "sb_secret_abcd" },
    { apikey: "sb_publishable_abc" },
    { Authorization: "Bearer sb_secret_abc" },
    { apikey: serviceRoleJwt, Authorization: `Bearer ${serviceRoleJwt}` },
  ];
  for (const headers of cases) {
    assertEquals(hasSecretKey(req(headers), KEYS), false, JSON.stringify(headers));
  }
});

Deno.test("with no secret keys configured nothing gets in", () => {
  assertEquals(hasSecretKey(req({ apikey: "" }), {}), false);
  assertEquals(hasSecretKey(req({ apikey: "anything" }), parseSecretKeys(undefined)), false);
});

Deno.test("parseSecretKeys keeps named non-empty strings and survives bad input", () => {
  assertEquals(parseSecretKeys('{"default":"k","empty":"","n":3}'), { default: "k" });
  assertEquals(parseSecretKeys("not json"), {});
  assertEquals(parseSecretKeys("null"), {});
  assertEquals(parseSecretKeys('"abc"'), {});
  assertEquals(parseSecretKeys('["sb_secret_abc"]'), {});
});
