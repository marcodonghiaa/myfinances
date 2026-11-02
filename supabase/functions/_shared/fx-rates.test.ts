import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fetchRateToEur, fxRows } from "./fx-rates.ts";

function withFetch(response: () => Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.resolve(response());
  };
  return run().finally(() => {
    globalThis.fetch = original;
  }).then(() => calls);
}

Deno.test("EUR row plus the inverse of each units-per-EUR rate", () => {
  assertEquals(fxRows("2026-10-28", { USD: 2, GBP: 4 }), [
    { date: "2026-10-28", currency: "EUR", rate_to_eur: 1 },
    { date: "2026-10-28", currency: "USD", rate_to_eur: 0.5 },
    { date: "2026-10-28", currency: "GBP", rate_to_eur: 0.25 },
  ]);
});

Deno.test("fetchRateToEur returns the rate and the rows to store", async () => {
  const body = { date: "2026-11-02", rates: { CAD: 2 } };
  await withFetch(() => Response.json(body), async () => {
    const found = await fetchRateToEur("CAD");
    assertEquals(found?.rate, 0.5);
    assertEquals(found?.rows.map((r) => r.currency), ["EUR", "CAD"]);
  });
});

Deno.test("fetchRateToEur does not call out for a code that is not a currency", async () => {
  const calls = await withFetch(() => Response.json({}), async () => {
    for (const bad of ["ZAc", "", "CAD&x=1"]) assertEquals(await fetchRateToEur(bad), null, bad);
  });
  assertEquals(calls, 0);
});

Deno.test("fetchRateToEur is null when the reply has no such rate, and throws on a failed call", async () => {
  await withFetch(() => Response.json({ date: "2026-11-02", rates: {} }), async () => {
    assertEquals(await fetchRateToEur("TWD"), null);
  });
  await withFetch(() => new Response("{}", { status: 404 }), async () => {
    await assertRejects(() => fetchRateToEur("TWD"), Error, "404");
  });
});
