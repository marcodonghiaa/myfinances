import { assertEquals } from "jsr:@std/assert@1";
import { matchAccount, matchPatch } from "./account-match.ts";

const eur = { uid: "u-eur", iban: "LT01", currency: "EUR", identification_hash: "h-eur" };
const old = { uid: "u-old", iban: "IT60", currency: "EUR", identification_hash: null };
const noBank = { bank_name: null, bank_country: null, bank_logo: null };

Deno.test("matches on identification_hash first", () => {
  assertEquals(matchAccount([eur], { iban: "LT01", currency: "EUR", identification_hash: "h-eur" }), "u-eur");
});
Deno.test("same IBAN, different currency is a new pocket", () => {
  assertEquals(matchAccount([eur], { iban: "LT01", currency: "USD", identification_hash: "h-usd" }), null);
});
Deno.test("falls back to IBAN + currency when the stored hash was cleared", () => {
  assertEquals(matchAccount([old], { iban: "IT60", currency: "EUR", identification_hash: "h-new" }), "u-old");
});
Deno.test("no IBAN and no hash never matches", () => {
  assertEquals(matchAccount([old], { iban: null, currency: "EUR", identification_hash: null }), null);
});
Deno.test("hash match wins over an earlier IBAN + currency match", () => {
  const legacy = { uid: "u-legacy", iban: "LT01", currency: "EUR", identification_hash: null };
  assertEquals(matchAccount([legacy, eur], { iban: "LT01", currency: "EUR", identification_hash: "h-eur" }), "u-eur");
});
Deno.test("matchPatch stores the new session's account id and consent", () => {
  const p = matchPatch({ iban: "IT77X", currency: "EUR", identification_hash: "h1", label: "Main" }, "new-uid", "2027-04-25", noBank);
  assertEquals(p, { eb_account_uid: "new-uid", consent_valid_until: "2027-04-25", currency: "EUR", iban: "IT77X", identification_hash: "h1", label: "Main" });
});
Deno.test("matchPatch leaves iban, hash and label alone when the bank sends none", () => {
  const p = matchPatch({ iban: null, currency: "USD", identification_hash: null, label: null }, "u2", null, noBank);
  assertEquals(p, { eb_account_uid: "u2", consent_valid_until: null, currency: "USD" });
});
Deno.test("matchPatch stores the bank when EB sends it", () => {
  const bank = { bank_name: "Fineco", bank_country: "IT", bank_logo: "https://logo" };
  const p = matchPatch({ iban: null, currency: "EUR", identification_hash: null, label: null }, "u3", null, bank);
  assertEquals(p, { eb_account_uid: "u3", consent_valid_until: null, currency: "EUR", ...bank });
});
Deno.test("matchPatch never blanks a stored bank field EB omits", () => {
  const bank = { bank_name: "Fineco", bank_country: "IT", bank_logo: null };
  const p = matchPatch({ iban: null, currency: "EUR", identification_hash: null, label: null }, "u4", null, bank);
  assertEquals(p, { eb_account_uid: "u4", consent_valid_until: null, currency: "EUR", bank_name: "Fineco", bank_country: "IT" });
});
