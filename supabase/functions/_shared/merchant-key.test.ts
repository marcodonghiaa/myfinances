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

// protects=two shops of one type never share a key; fails_when=a processor code or shop-type word becomes the key
Deno.test("different shops of one type, or behind one processor, never share a key", () => {
  for (
    const [a, b] of [
      ["ZETTLE_*BAR ROSSI", "ZETTLE_*BAR VERDI"],
      ["BAR SPORT MILANO IT", "BAR SPORT ROMA IT"],
      ["BAR SPORT 2000", "BAR SPORT 3000"],
      ["FORNO 2 MILANO", "FORNO 5 ROMA"],
      ["TRATTORIA DA MARIO 2", "TRATTORIA DA MARIO 3"],
      ["PIZZERIA ROSSI S.A.S. DI VERDI", "PIZZERIA ROSSI S.A.S. DI BIANCHI"],
      ["ROSSI", "BAR*ROSSI"],
      ["BAR*ROSSI", "PUB*ROSSI"],
      ["SQU*SQ *ACME", "SQU*SQ *ROSSI"],
      ["NAYAX*BAR ROSSI", "NAYAX*BAR VERDI"],
      ["MYPOS*ROSSI", "MYPOS*VERDI"],
      ["VIVA*ROSSI", "VIVA*VERDI"],
      ["IL FORNO 2", "IL FORNO 3"],
      ["LA BOTTEGA ACME 2", "LA BOTTEGA ACME 3"],
    ]
  ) assertNotEquals(normalizeMerchant(a).key, normalizeMerchant(b).key, `${a} vs ${b}`);
});
