import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { normalizeMerchant } from "./merchant-key.ts";
import cases from "./merchant-key.cases.json" with { type: "json" };

for (const c of cases as { in: string | null; key: string | null; aggregator?: string }[]) {
  Deno.test(`normalizeMerchant(${JSON.stringify(c.in)})`, () => {
    assertEquals(normalizeMerchant(c.in), { key: c.key, aggregator: c.aggregator ?? null });
  });
}

Deno.test("falls back to the trimmed input when every token is stripped", () => {
  assertEquals(normalizeMerchant(" IT "), { key: "it", aggregator: null });
});

Deno.test("fallback collapses whitespace", () => {
  assertEquals(normalizeMerchant("  PAYPAL *   IT "), { key: "paypal * it", aggregator: null });
});

Deno.test("two different bars never share a key", () => {
  assertNotEquals(normalizeMerchant("BAR 2000 MILANO IT").key, normalizeMerchant("BAR ROMA IT").key);
});
