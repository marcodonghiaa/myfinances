// Deno port of fx-sync.js, sync-portfolio-prices.js and sync-crypto-prices.js, run by sync-prices.
// No bank calls: Frankfurter (rates), Yahoo (stock/ETF prices) and CoinGecko (coin prices).
import { fxRows } from "./fx-rates.ts";
import { parseYahooChart } from "./holdings.ts";
import { errorTag } from "./log-safe.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
type Json = Record<string, unknown>;
/** GET a URL and return its JSON; throws with the status only on a bad answer. */
export type GetJson = (url: string, headers?: Record<string, string>) => Promise<Json>;

const HISTORY_DAYS = 100; // the bank sync reads 90 days; every view needs a rate on or before each booking_date
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export const getJson: GetJson = async (url, headers = {}) => {
  // 10 s: a quote answers in well under a second; a hung host must not eat the 150 s wall clock.
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} error ${res.status}`), { status: res.status });
  return res.json();
};

async function upsertFx(db: Db, rows: ReturnType<typeof fxRows>) {
  const { error } = await db.from("fx_rates").upsert(rows, { onConflict: "date,currency" });
  if (error) throw error;
}

// Every Frankfurter currency, latest day. A fresh install first gets 100 days of history, or
// transactions booked before the first fx_rates row would drop out of the inner-joined views.
export async function syncFx(db: Db, get: GetJson): Promise<number> {
  const { data, error } = await db.from("fx_rates").select("date").lt("date", daysAgo(HISTORY_DAYS - 20)).limit(1);
  if (error) throw error;
  let rows = 0;
  if (data.length === 0) {
    const series = await get(`https://api.frankfurter.dev/v1/${daysAgo(HISTORY_DAYS)}..?base=EUR`);
    const history = Object.entries(series.rates as Record<string, Record<string, number>>).flatMap(([d, r]) => fxRows(d, r));
    await upsertFx(db, history);
    rows += history.length;
  }
  const latest = await get("https://api.frankfurter.dev/v1/latest?base=EUR");
  const today = fxRows(latest.date as string, latest.rates as Record<string, number>);
  await upsertFx(db, today);
  return rows + today.length;
}

async function latestRate(db: Db, currency: string): Promise<number> {
  if (currency === "EUR") return 1;
  const { data, error } = await db
    .from("fx_rates").select("rate_to_eur").eq("currency", currency).order("date", { ascending: false }).limit(1);
  if (error) throw error;
  if (!data?.length) throw Object.assign(new Error("no fx rate"), { code: "NO_FX_RATE" });
  return data[0].rate_to_eur;
}

// Yahoo calls bond funds ETFs, so a holding marked Bond by hand keeps that label.
export const nextAssetType = (current: string | null, fromYahoo: string) => (current === "Bond" ? "Bond" : fromYahoo);

export interface Holding {
  user_id: string;
  isin: string;
  yahoo_symbol: string;
  shares: number;
  asset_type: string | null;
}

// One snapshot per holding, each under its own user. A symbol held by several users is fetched
// once. A holding that can't be priced is skipped and logged by position only.
export async function priceHoldings(
  holdings: Holding[],
  getQuote: (symbol: string) => Promise<{ price: number; currency: string; assetType: string }>,
  getRate: (currency: string) => Promise<number>,
  today: string,
  timeLeft: () => boolean = () => true,
) {
  const quotes = new Map<string, ReturnType<typeof getQuote>>();
  const quoteOf = (symbol: string) => {
    if (!quotes.has(symbol)) quotes.set(symbol, getQuote(symbol));
    return quotes.get(symbol)!;
  };
  const rows = [];
  const typeUpdates = [];
  for (const [i, holding] of holdings.entries()) {
    if (!timeLeft()) {
      console.error(`Out of time: ${holdings.length - i} holding(s) left for the next run.`);
      break;
    }
    try {
      const { price, currency, assetType } = await quoteOf(holding.yahoo_symbol);
      const valueNative = price * holding.shares;
      rows.push({
        user_id: holding.user_id,
        isin: holding.isin,
        snapshot_date: today,
        price,
        currency,
        value_native: valueNative,
        value_eur: valueNative * (await getRate(currency)),
      });
      const newType = assetType && nextAssetType(holding.asset_type, assetType);
      if (newType && newType !== holding.asset_type) typeUpdates.push({ user_id: holding.user_id, isin: holding.isin, asset_type: newType });
    } catch (err) {
      console.error(`Failed to price holding ${i + 1}/${holdings.length}: ${errorTag(err)}`);
    }
  }
  return { rows, typeUpdates };
}

export async function syncPortfolio(db: Db, get: GetJson, today: string, timeLeft?: () => boolean): Promise<number> {
  const { data: holdings, error } = await db.from("portfolio_holdings").select("user_id, isin, yahoo_symbol, shares, asset_type");
  if (error) throw error;
  const { rows, typeUpdates } = await priceHoldings(
    holdings,
    async (symbol) =>
      parseYahooChart(
        await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
          "User-Agent": "Mozilla/5.0",
        }),
        symbol,
      ),
    (currency) => latestRate(db, currency),
    today,
    timeLeft,
  );
  for (const u of typeUpdates) {
    const { error } = await db.from("portfolio_holdings").update({ asset_type: u.asset_type }).eq("user_id", u.user_id).eq("isin", u.isin);
    if (error) console.error(`Failed to update asset_type for a holding: ${errorTag(error)}`);
  }
  if (rows.length > 0) {
    const { error } = await db.from("portfolio_snapshots").upsert(rows, { onConflict: "user_id,isin,snapshot_date" });
    if (error) throw error;
  }
  return rows.length;
}

export interface CoinHolding {
  user_id: string;
  asset_symbol: string;
  amount: number;
  source: string;
  coingecko_id: string;
}

// One snapshot per holding, each under its own user. A coin without a price is skipped.
export function cryptoRows(holdings: CoinHolding[], prices: Record<string, { usd?: number }>, usdToEur: number, today: string) {
  const rows = [];
  for (const [i, h] of holdings.entries()) {
    const priceUsd = prices[h.coingecko_id]?.usd;
    if (!(typeof priceUsd === "number" && priceUsd > 0)) {
      console.error(`No price found for holding ${i + 1}/${holdings.length}`);
      continue;
    }
    const valueUsd = priceUsd * h.amount;
    rows.push({
      user_id: h.user_id,
      asset_symbol: h.asset_symbol,
      source: h.source,
      snapshot_date: today,
      amount: h.amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      value_eur: valueUsd * usdToEur,
    });
  }
  return rows;
}

export async function syncCrypto(db: Db, get: GetJson, today: string): Promise<number> {
  const { data: holdings, error } = await db.from("crypto_holdings").select("user_id, asset_symbol, amount, source, coingecko_id");
  if (error) throw error;
  if (holdings.length === 0) return 0;
  const ids = [...new Set(holdings.map((h: CoinHolding) => h.coingecko_id))].join(",");
  const prices = await get(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`, {
    Accept: "application/json",
  });
  const rows = cryptoRows(holdings, prices as Record<string, { usd?: number }>, await latestRate(db, "USD"), today);
  if (rows.length > 0) {
    const { error } = await db.from("crypto_snapshots").upsert(rows, { onConflict: "user_id,asset_symbol,source,snapshot_date" });
    if (error) throw error;
  }
  return rows.length;
}
