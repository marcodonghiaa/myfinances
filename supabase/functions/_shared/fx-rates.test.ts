import { assertEquals } from "jsr:@std/assert@1";
import { fxRows } from "./fx-rates.ts";

Deno.test("EUR row plus the inverse of each units-per-EUR rate", () => {
  assertEquals(fxRows("2026-10-28", { USD: 2, GBP: 4 }), [
    { date: "2026-10-28", currency: "EUR", rate_to_eur: 1 },
    { date: "2026-10-28", currency: "USD", rate_to_eur: 0.5 },
    { date: "2026-10-28", currency: "GBP", rate_to_eur: 0.25 },
  ]);
});
