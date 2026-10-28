import { assertEquals } from "jsr:@std/assert@1";
import { isServiceRole } from "./service-role.ts";

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
const req = (auth?: string) => new Request("http://x", auth ? { headers: { Authorization: auth } } : {});

Deno.test("isServiceRole accepts a service_role JWT", () => {
  assertEquals(isServiceRole(req(`Bearer ${jwt({ role: "service_role" })}`)), true);
});

Deno.test("isServiceRole rejects anon and authenticated JWTs", () => {
  assertEquals(isServiceRole(req(`Bearer ${jwt({ role: "anon" })}`)), false);
  assertEquals(isServiceRole(req(`Bearer ${jwt({ role: "authenticated", sub: "u" })}`)), false);
  assertEquals(isServiceRole(req(`Bearer ${jwt({})}`)), false);
});

Deno.test("isServiceRole rejects missing or malformed headers", () => {
  const good = jwt({ role: "service_role" });
  for (const bad of [undefined, "", "Bearer", "Bearer x", "Bearer a.b", good, `Basic ${good}`,
    `Bearer a.${b64url("service_role")}.c`, "Bearer a.!!!.c", `Bearer a.${btoa("not json")}.c`]) {
    assertEquals(isServiceRole(req(bad)), false, `rejects ${bad}`);
  }
});
