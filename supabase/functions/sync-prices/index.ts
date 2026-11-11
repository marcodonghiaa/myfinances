// Supabase Edge Function: sync-prices
//
// The launchd pipeline's fx-sync, sync-portfolio-prices, sync-crypto-coinbase and
// sync-crypto-prices, moved into Supabase: today's exchange rates, a price snapshot for every
// stock/ETF, the owner's Coinbase balances (optional), then a price snapshot for every coin.
// No bank calls. Rates go first because both price steps convert with them; one step failing
// doesn't stop the others. Callers send a project secret key on the apikey header.

import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { getJson, syncCrypto, syncFx, syncPortfolio } from "../_shared/prices.ts";
import { syncCoinbase } from "../_shared/coinbase.ts";

// Optional: without the key name and private key the Coinbase step is skipped (null in the result).
const COINBASE = {
  keyName: Deno.env.get("COINBASE_API_KEY_NAME"),
  privateKey: Deno.env.get("COINBASE_API_PRIVATE_KEY"),
  userId: Deno.env.get("COINBASE_USER_ID"),
};

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// A step's count, or null when it failed (logged by tag only).
// Stop pricing more holdings after this, so the crypto step still runs under the 150 s wall clock.
const PORTFOLIO_BUDGET_MS = 90000;

const FAILED = "failed";

async function step(name: string, run: () => Promise<number | null>): Promise<number | null | typeof FAILED> {
  try {
    return await run();
  } catch (err) {
    console.error(`sync-prices ${name} failed: ${errorTag(err)}`);
    return FAILED;
  }
}

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const today = new Date().toISOString().slice(0, 10);
  const fx = await step("fx", () => syncFx(supabase, getJson));
  const portfolio = await step("portfolio", () => syncPortfolio(supabase, getJson, today, () => Date.now() - started < PORTFOLIO_BUDGET_MS));
  // Coinbase before the crypto step, so today's prices use today's balances.
  const coinbase = await step("coinbase", () => syncCoinbase(supabase, COINBASE));
  const crypto = await step("crypto", () => syncCrypto(supabase, getJson, today));
  const result = { fx, portfolio, coinbase, crypto, ms: Date.now() - started };
  console.log(`sync-prices: ${JSON.stringify(result)}`);
  const failed = [fx, portfolio, coinbase, crypto].includes(FAILED);
  return Response.json(result, { status: failed ? 500 : 200 });
});
