import { assertEquals } from "jsr:@std/assert@1";
import { bankLogo } from "./bank-info.ts";

const aspsps = [
  { name: "Fineco", logo: "https://enablebanking.com/brands/IT/Fineco/" },
  { name: "Revolut", logo: null },
];

Deno.test("bankLogo returns the logo of the exact name match", () => {
  assertEquals(bankLogo(aspsps, "Fineco"), "https://enablebanking.com/brands/IT/Fineco/");
});
Deno.test("bankLogo returns null when no bank has that name", () => {
  assertEquals(bankLogo(aspsps, "fineco"), null);
});
Deno.test("bankLogo returns null for a null list", () => {
  assertEquals(bankLogo(null, "Fineco"), null);
});
Deno.test("bankLogo returns null when the match has no logo", () => {
  assertEquals(bankLogo(aspsps, "Revolut"), null);
});
