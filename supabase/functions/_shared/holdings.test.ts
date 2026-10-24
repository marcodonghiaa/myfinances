import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  isIsin,
  parseCoinGeckoSearch,
  parseHoldingRequest,
  parseYahooChart,
  parseYahooSearch,
} from "./holdings.ts";

Deno.test("isIsin accepts real ISINs only", () => {
  assertEquals(isIsin("IE00B4L5Y983"), true);
  for (const bad of ["IE00B4L5Y98", "ie00b4l5y983", "VWCE", "IE00B4L5Y98X", ""]) {
    assertEquals(isIsin(bad), false, bad);
  }
});

Deno.test("Yahoo search keeps securities and drops news, futures and options", () => {
  const candidates = parseYahooSearch({
    quotes: [
      { symbol: "VWCE.DE", longname: "Vanguard FTSE All-World", quoteType: "ETF", exchDisp: "XETRA" },
      { symbol: "AAPL", shortname: "Apple Inc.", quoteType: "EQUITY", exchDisp: "NASDAQ" },
      { symbol: "ES=F", shortname: "S&P Future", quoteType: "FUTURE" },
      { symbol: "X", quoteType: "EQUITY" }, // no name
    ],
  });
  assertEquals(candidates, [
    { id: "VWCE.DE", symbol: "VWCE.DE", name: "Vanguard FTSE All-World", detail: "ETF · XETRA" },
    { id: "AAPL", symbol: "AAPL", name: "Apple Inc.", detail: "Stock · NASDAQ" },
  ]);
  assertEquals(parseYahooSearch({}), []);
});

Deno.test("Yahoo chart gives price, currency and type; pence become pounds", () => {
  assertEquals(
    parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 120.5, currency: "EUR", instrumentType: "ETF" } }] } }, "VWCE.DE"),
    { price: 120.5, currency: "EUR", assetType: "ETF" },
  );
  assertEquals(
    parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 1234, currency: "GBp", instrumentType: "EQUITY" } }] } }, "VOD.L"),
    { price: 12.34, currency: "GBP", assetType: "Stock" },
  );
  assertThrows(() => parseYahooChart({ chart: { result: [{ meta: { currency: "EUR" } }] } }, "X"), Error, "No valid price");
  assertThrows(() => parseYahooChart({ chart: { result: [] } }, "X"), Error, "No quote");
});

Deno.test("CoinGecko search keeps the top coins with an id, symbol and name", () => {
  assertEquals(
    parseCoinGeckoSearch({
      coins: [
        { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 },
        { id: "", symbol: "x", name: "Broken" },
      ],
    }),
    [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", detail: "Rank #1" }],
  );
});

Deno.test("a search request needs a kind and a short query", () => {
  assertEquals(parseHoldingRequest({ action: "search", kind: "stock", query: "  vwce " }), {
    action: "search",
    kind: "stock",
    query: "vwce",
  });
  for (const bad of [
    { action: "search", kind: "bond", query: "x" },
    { action: "search", kind: "stock", query: "" },
    { action: "search", kind: "stock", query: "x".repeat(51) },
    { action: "delete", kind: "stock", query: "x" },
    null,
  ]) {
    assertEquals(typeof parseHoldingRequest(bad), "string", JSON.stringify(bad));
  }
});

Deno.test("an add request needs a valid id, name and a positive quantity", () => {
  const stock = { action: "add", kind: "stock", id: "VWCE.DE", symbol: "VWCE.DE", name: "Vanguard", quantity: 3.5, isin: "IE00BK5BQT80", broker: "Degiro" } as const;
  assertEquals(parseHoldingRequest(stock), stock);
  assertEquals(parseHoldingRequest({ ...stock, isin: undefined, broker: undefined }), {
    ...stock,
    isin: undefined,
    broker: undefined,
  });
  for (const patch of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: "3" },
    { quantity: Infinity },
    { id: "bad symbol!" },
    { name: "" },
    { isin: "nope" },
    { broker: "x".repeat(41) },
  ]) {
    assertEquals(typeof parseHoldingRequest({ ...stock, ...patch }), "string", JSON.stringify(patch));
  }
  const coin = { action: "add", kind: "crypto", id: "bitcoin", symbol: "BTC", name: "Bitcoin", quantity: 0.25 } as const;
  assertEquals(parseHoldingRequest(coin), { ...coin, isin: undefined, broker: undefined });
  assertEquals(typeof parseHoldingRequest({ ...coin, id: "Bitcoin!" }), "string");
});
