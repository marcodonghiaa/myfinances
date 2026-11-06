import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildJwt, fetchAllAccounts, importCoinbaseKey, planHoldings, syncCoinbase } from "./coinbase.ts";

const account = (currency: string, value: unknown, over: Record<string, unknown> = {}) => ({ currency, name: `${currency} Wallet`, available_balance: { value }, ...over });

Deno.test("a funded, mapped account becomes a holding row; zero balances are listed to zero", () => {
  assertEquals(planHoldings([account("USDC", "12.5")], "u1").rows, [
    { user_id: "u1", asset_symbol: "USDC", name: "USDC Wallet", amount: 12.5, source: "Coinbase", coingecko_id: "usd-coin" },
  ]);
  const { rows, zeroed } = planHoldings([account("BTC", "0"), account("ETH", "0.00000000")], "u1");
  assertEquals([rows, zeroed], [[], ["BTC", "ETH"]]);
});

Deno.test("a malformed balance is skipped, never treated as zero; unmapped coins are neither written nor zeroed", () => {
  assertEquals(planHoldings([account("BTC", "oops"), account("ETH", undefined, { available_balance: undefined })], "u1"), { rows: [], zeroed: [], unmapped: [] });
  const { rows, zeroed, unmapped } = planHoldings([account("DOGE", "5"), account("SOL", "0")], "u1");
  assertEquals([rows, zeroed, unmapped], [[], [], ["DOGE"]]);
});

// Regression: only the first page (about 49 accounts) was read.
Deno.test("follows the cursor until the last page, and a repeating cursor ends the walk", async () => {
  const pages: Record<string, Record<string, unknown>> = {
    "": { accounts: [{ id: 1 }, { id: 2 }], has_next: true, cursor: "c2" },
    c2: { accounts: [{ id: 3 }], has_next: true, cursor: "c3" },
    c3: { accounts: [{ id: 4 }], has_next: false, cursor: "" },
  };
  const asked: Array<string | null> = [];
  const accounts = await fetchAllAccounts(async (cursor) => (asked.push(cursor), pages[cursor ?? ""]));
  assertEquals([accounts.map((a) => a.id), asked], [[1, 2, 3, 4], [null, "c2", "c3"]]);
  let calls = 0;
  assertEquals((await fetchAllAccounts(async () => (calls++, { accounts: [{ id: calls }], has_next: true, cursor: "same" }))).length, 2);
});

// protects=Coinbase accepts the request; fails_when=the Coinbase-format key (seed + public key)
// imports wrong or the signature doesn't verify against the key's public half
Deno.test("signs an EdDSA JWT with a Coinbase-format key that its public key verifies", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const coinbaseKey = btoa(String.fromCharCode(...pkcs8.slice(-32), ...pub));
  const jwt = await buildJwt("organizations/x/apiKeys/y", await importCoinbaseKey(coinbaseKey), 1_800_000_000);
  const [h, p, s] = jwt.split(".");
  const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  assertEquals(JSON.parse(new TextDecoder().decode(dec(h))).alg, "EdDSA");
  assertEquals(JSON.parse(new TextDecoder().decode(dec(p))), {
    sub: "organizations/x/apiKeys/y", iss: "cdp", nbf: 1_800_000_000, exp: 1_800_000_120, uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
  });
  assert(await crypto.subtle.verify({ name: "Ed25519" }, pair.publicKey, dec(s), new TextEncoder().encode(`${h}.${p}`)));
});

Deno.test("without keys the step is skipped; with keys but no owner it fails clearly", async () => {
  assertEquals(await syncCoinbase({ from: () => ({}) }, {}), null);
  const err = await syncCoinbase({ from: () => ({}) }, { keyName: "k", privateKey: "p" }).catch((e) => e);
  assertEquals(err.code, "COINBASE_USER_ID_MISSING");
});
