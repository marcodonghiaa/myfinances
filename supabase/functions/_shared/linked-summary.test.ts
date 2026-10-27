import { assertEquals } from "jsr:@std/assert@1";
import { linkedParams } from "./linked-summary.ts";

Deno.test("names the bank and each currency once, sorted", () => {
  assertEquals(linkedParams(3, "Revolut", ["EUR", "USD", "EUR", "GBP"]), { bank_linked: "3", bank: "Revolut", currencies: "EUR,GBP,USD" });
});
Deno.test("no bank name and no currencies: count only", () => {
  assertEquals(linkedParams(1, null, []), { bank_linked: "1" });
});
Deno.test("a bank name with spaces and accents survives the redirect URL", () => {
  const url = new URL("https://app.example/accounts");
  for (const [key, value] of Object.entries(linkedParams(1, "Crédit Agricole", ["EUR"]))) url.searchParams.set(key, value);
  const back = new URL(url.toString()).searchParams;
  assertEquals(back.get("bank"), "Crédit Agricole");
  assertEquals(back.get("currencies"), "EUR");
});
