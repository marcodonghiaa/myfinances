// Parsing and input checks for add-holding. Kept free of Deno APIs so the tests run anywhere.

export type HoldingKind = "stock" | "crypto";

export interface Candidate {
  id: string; // Yahoo symbol for a stock or ETF, CoinGecko id for a coin
  symbol: string;
  name: string;
  detail: string;
}

export interface Quote {
  price: number;
  currency: string;
  assetType: string;
}

export type HoldingRequest =
  | { action: "search"; kind: HoldingKind; query: string }
  | {
    action: "add";
    kind: HoldingKind;
    id: string;
    symbol: string;
    name: string;
    quantity: number;
    isin: string | undefined;
    broker: string | undefined;
  };

export const MAX_QUERY_LENGTH = 50;
const MAX_RESULTS = 8;

export const isIsin = (value: string): boolean => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value);

// Same labels the price sync stores in portfolio_holdings.asset_type (yahoo-quote.js).
const ASSET_TYPE: Record<string, string> = { EQUITY: "Stock", ETF: "ETF", MUTUALFUND: "Fund", BOND: "Bond" };

type Json = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function parseYahooSearch(data: Json): Array<Candidate> {
  const quotes = Array.isArray(data.quotes) ? (data.quotes as Array<Json>) : [];
  return quotes
    .filter((q) => text(q.quoteType) in ASSET_TYPE)
    .map((q) => ({
      id: text(q.symbol),
      symbol: text(q.symbol),
      name: text(q.longname) || text(q.shortname),
      detail: [ASSET_TYPE[text(q.quoteType)], text(q.exchDisp)].filter(Boolean).join(" · "),
    }))
    .filter((c) => c.id !== "" && c.name !== "")
    .slice(0, MAX_RESULTS);
}

// Rejects a missing price so a NaN never reaches a snapshot. London quotes come in pence (GBp).
export function parseYahooChart(data: Json, symbol: string): Quote {
  const result = ((data.chart as Json | undefined)?.result as Array<Json> | undefined)?.[0];
  if (!result) throw new Error(`No quote for ${symbol}`);
  const meta = (result.meta ?? {}) as Json;
  const price = meta.regularMarketPrice;
  if (typeof price !== "number" || !Number.isFinite(price)) throw new Error(`No valid price for ${symbol}`);
  const assetType = ASSET_TYPE[text(meta.instrumentType)] ?? "Other";
  if (meta.currency === "GBp") return { price: price / 100, currency: "GBP", assetType };
  return { price, currency: text(meta.currency), assetType };
}

export function parseCoinGeckoSearch(data: Json): Array<Candidate> {
  const coins = Array.isArray(data.coins) ? (data.coins as Array<Json>) : [];
  return coins
    .map((c) => ({
      id: text(c.id),
      symbol: text(c.symbol).toUpperCase(),
      name: text(c.name),
      detail: typeof c.market_cap_rank === "number" ? `Rank #${c.market_cap_rank}` : "Crypto",
    }))
    .filter((c) => c.id !== "" && c.symbol !== "" && c.name !== "")
    .slice(0, MAX_RESULTS);
}

const isKind = (v: unknown): v is HoldingKind => v === "stock" || v === "crypto";
const ID_PATTERN: Record<HoldingKind, RegExp> = {
  stock: /^[A-Za-z0-9.\-=^]{1,20}$/,
  crypto: /^[a-z0-9-]{1,80}$/,
};

// Returns the checked request, or a message for a 400.
export function parseHoldingRequest(body: unknown): HoldingRequest | string {
  if (!body || typeof body !== "object") return "Invalid request";
  const b = body as Json;
  if (!isKind(b.kind)) return "kind must be stock or crypto";

  if (b.action === "search") {
    const query = text(b.query);
    if (query === "" || query.length > MAX_QUERY_LENGTH) return `query must be 1-${MAX_QUERY_LENGTH} characters`;
    return { action: "search", kind: b.kind, query };
  }
  if (b.action !== "add") return "action must be search or add";

  const id = text(b.id);
  const symbol = text(b.symbol);
  const name = text(b.name);
  const isin = b.isin === undefined ? undefined : text(b.isin);
  const broker = b.broker === undefined ? undefined : text(b.broker);
  if (!ID_PATTERN[b.kind].test(id)) return "Invalid id";
  if (symbol === "" || symbol.length > 20) return "Invalid symbol";
  if (name === "" || name.length > 120) return "Invalid name";
  if (typeof b.quantity !== "number" || !Number.isFinite(b.quantity) || b.quantity <= 0 || b.quantity > 1e12) {
    return "quantity must be a positive number";
  }
  if (isin !== undefined && !isIsin(isin)) return "Invalid ISIN";
  if (broker !== undefined && broker.length > 40) return "broker must be at most 40 characters";
  return { action: "add", kind: b.kind, id, symbol, name, quantity: b.quantity, isin, broker };
}
