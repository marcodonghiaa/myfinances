// Supabase Edge Function: sync-prices
//
// The launchd pipeline's fx-sync, sync-portfolio-prices and sync-crypto-prices, moved into
// Supabase: today's exchange rates, then a price snapshot for every stock/ETF and coin holding.
// No bank calls. Rates go first because both price steps convert with them; one step failing
// doesn't stop the others. Callers send a project secret key on the apikey header.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { getJson, syncCrypto, syncFx, syncPortfolio } from "../_shared/prices.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// A step's count, or null when it failed (logged by tag only).
// Stop pricing more holdings after this, so the crypto step still runs under the 150 s wall clock.
const PORTFOLIO_BUDGET_MS = 90000;

async function step(name: string, run: () => Promise<number>): Promise<number | null> {
  try {
    return await run();
  } catch (err) {
    console.error(`sync-prices ${name} failed: ${errorTag(err)}`);
    return null;
  }
}

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const today = new Date().toISOString().slice(0, 10);
  const fx = await step("fx", () => syncFx(supabase, getJson));
  const portfolio = await step("portfolio", () => syncPortfolio(supabase, getJson, today, () => Date.now() - started < PORTFOLIO_BUDGET_MS));
  const crypto = await step("crypto", () => syncCrypto(supabase, getJson, today));
  const result = { fx, portfolio, crypto, ms: Date.now() - started };
  console.log(`sync-prices: ${JSON.stringify(result)}`);
  const failed = [result.fx, result.portfolio, result.crypto].includes(null);
  return Response.json(result, { status: failed ? 500 : 200 });
});
