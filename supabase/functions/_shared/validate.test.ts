import { assertEquals } from "jsr:@std/assert@1";
import { isBankName, isCountryCode, MAX_BANK_NAME_LENGTH } from "./validate.ts";

Deno.test("isCountryCode accepts two capital letters only", () => {
  assertEquals(isCountryCode("IT"), true);
  for (const bad of ["it", "ITA", "I", "", "I1", " IT", "IT\n", 7, null, undefined, {}]) {
    assertEquals(isCountryCode(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

Deno.test("isBankName accepts real names and rejects junk", () => {
  assertEquals(isBankName("Intesa Sanpaolo"), true);
  assertEquals(isBankName("x".repeat(MAX_BANK_NAME_LENGTH)), true);
  for (const bad of ["", "   ", "x".repeat(MAX_BANK_NAME_LENGTH + 1), 7, null, undefined, ["a"]]) {
    assertEquals(isBankName(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});
