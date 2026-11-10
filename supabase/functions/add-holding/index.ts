// Supabase Edge Function: add-holding
//
// Lets the dashboard add an investment or a coin without SQL.
// - { action: "search", kind, query }: looks the name, ticker or ISIN up on Yahoo Finance
//   (stocks, ETFs, funds) or CoinGecko (crypto) and returns up to 8 candidates.
// - { action: "add", kind, id, symbol, name, quantity, isin?, broker? }: saves the holding as the
//   signed-in user (RLS applies) and stores today's price, so it shows on the dashboard at once
//   instead of after the next price sync. The price is fetched here, never taken from the browser.
//
// Requires a signed-in user, like list-banks: otherwise this is an open proxy to Yahoo/CoinGecko.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { fetchRateToEur } from "../_shared/fx-rates.ts";
import { MFA_REQUIRED, mfaSatisfied } from "../_shared/mfa.ts";
import {
  HoldingError,
  type HoldingRequest,
  parseCoinGeckoPrice,
  parseCoinGeckoSearch,
  parseHoldingRequest,
  parseYahooChart,
  parseYahooSearch,
  upstreamMessage,
} from "../_shared/holdings.ts";

type AddRequest = Extract<HoldingRequest, { action: "add" }>;

const TIMEOUT_MS = 15_000;
const DUPLICATE_KEY = "23505";

async function getJson(url: string): Promise<Record<string, unknown>> {
  const { host } = new URL(url);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`${host} did not answer: ${errorTag(err)}`);
    throw new HoldingError(upstreamMessage(host, 0));
  }
  if (!res.ok) throw new HoldingError(upstreamMessage(host, res.status));
  return await res.json();
}

const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Latest stored rate, or today's from Frankfurter when fx-sync hasn't stored this currency yet.
// Throws when there is none: a holding with no value in EUR would show as 0 and never heal.
async function rateToEur(currency: string): Promise<number> {
  if (currency === "EUR") return 1;
  const { data } = await admin()
    .from("fx_rates")
    .select("rate_to_eur")
    .eq("currency", currency)
    .order("date", { ascending: false })
    .limit(1);
  const stored = data?.[0]?.rate_to_eur;
  if (stored != null) return stored;

  const found = await fetchRateToEur(currency).catch((err) => {
    console.error(`fx lookup failed: ${errorTag(err)}`);
    return null;
  });
  if (!found) throw new HoldingError(`No exchange rate for ${currency}, can't value this holding`);
  const { error } = await admin().from("fx_rates").upsert(found.rows, { onConflict: "date,currency" });
  if (error) console.error(`fx seed failed: ${errorTag(error)}`);
  return found.rate;
}

async function search(kind: "stock" | "crypto", query: string) {
  const q = encodeURIComponent(query);
  if (kind === "stock") {
    return parseYahooSearch(
      await getJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=10&newsCount=0`),
    );
  }
  return parseCoinGeckoSearch(await getJson(`https://api.coingecko.com/api/v3/search?query=${q}`));
}

// Inserts the holding with the user's own client (RLS checks it is theirs), then today's price
// with the service role (users can't write prices). Returns whether the price was stored.
// deno-lint-ignore no-explicit-any
async function addStock(userClient: any, userId: string, req: AddRequest): Promise<boolean> {
  const quote = parseYahooChart(
    await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.id)}?interval=1d&range=1d`),
    req.id,
  );
  const rate = await rateToEur(quote.currency);
  // portfolio_holdings is keyed by ISIN; a holding found by name or ticker has no ISIN, so the
  // Yahoo symbol stands in (still unique per user).
  const key = req.isin ?? req.id;
  const { error } = await userClient.from("portfolio_holdings").insert({
    user_id: userId,
    isin: key,
    yahoo_symbol: req.id,
    name: req.name,
    shares: req.quantity,
    broker_label: req.broker || "Other",
    asset_type: quote.assetType,
  });
  if (error) throw error;

  const valueNative = quote.price * req.quantity;
  const { error: snapError } = await admin().from("portfolio_snapshots").upsert({
    user_id: userId,
    isin: key,
    snapshot_date: new Date().toISOString().slice(0, 10),
    price: quote.price,
    currency: quote.currency,
    value_native: valueNative,
    value_eur: valueNative * rate,
  }, { onConflict: "user_id,isin,snapshot_date" });
  if (snapError) console.error(`Snapshot insert failed: ${errorTag(snapError)}`);
  return !snapError;
}

// deno-lint-ignore no-explicit-any
async function addCoin(userClient: any, userId: string, req: AddRequest): Promise<boolean> {
  const priceUsd = parseCoinGeckoPrice(
    await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(req.id)}&vs_currencies=usd`),
    req.id,
  );
  const rate = await rateToEur("USD");

  const { error } = await userClient.from("crypto_holdings").insert({
    user_id: userId,
    asset_symbol: req.symbol.toUpperCase(),
    name: req.name,
    amount: req.quantity,
    source: "Manual",
    coingecko_id: req.id,
  });
  if (error) throw error;

  const valueUsd = priceUsd * req.quantity;
  const { error: snapError } = await admin().from("crypto_snapshots").upsert({
    user_id: userId,
    asset_symbol: req.symbol.toUpperCase(),
    source: "Manual",
    snapshot_date: new Date().toISOString().slice(0, 10),
    amount: req.quantity,
    price_usd: priceUsd,
    value_usd: valueUsd,
    value_eur: valueUsd * rate,
  }, { onConflict: "user_id,asset_symbol,source,snapshot_date" });
  if (snapError) console.error(`Snapshot insert failed: ${errorTag(snapError)}`);
  return !snapError;
}

// Anything else (a database error, say) stays in the function log, not the browser.
const userMessage = (err: unknown, fallback: string) => err instanceof HoldingError ? err.message : fallback;

Deno.serve(serveWithCors(async (req, json) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: "Not signed in" }, 401);
  }
  if (!(await mfaSatisfied(userClient))) return json(MFA_REQUIRED, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseHoldingRequest(body);
  if (typeof parsed === "string") return json({ error: parsed }, 400);

  if (parsed.action === "search") {
    try {
      return json({ results: await search(parsed.kind, parsed.query) });
    } catch (err) {
      console.error(`Search failed: ${errorTag(err)}`);
      return json({ error: userMessage(err, "Search is unavailable right now, try again") }, 502);
    }
  }

  try {
    const add = parsed.kind === "stock" ? addStock : addCoin;
    const priced = await add(userClient, userData.user.id, parsed);
    return json({ added: true, priced });
  } catch (err) {
    if ((err as { code?: string }).code === DUPLICATE_KEY) {
      return json({ error: "Already in your holdings: change its quantity instead" }, 409);
    }
    console.error(`Add failed: ${errorTag(err)}`);
    return json({ error: userMessage(err, "Couldn't add it right now, try again") }, 502);
  }
}));
