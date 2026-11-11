import { assertEquals } from "jsr:@std/assert@1.0.19";
import { cryptoRows, type GetJson, type Holding, nextAssetType, priceHoldings, syncFx } from "./prices.ts";

const holding = (over: Partial<Holding> = {}): Holding => ({ user_id: "u1", isin: "IE00", yahoo_symbol: "VWCE.DE", shares: 2, asset_type: null, ...over });
const quiet = async <T>(run: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

// protects=each holding gets today's value in EUR without a Mac; fails_when=a symbol held twice is
// fetched twice, one bad holding drops the rest, or a hand-set Bond label is overwritten
Deno.test("prices each holding once per symbol, converts to EUR and skips what can't be priced", async () => {
  let quotes = 0;
  const { rows, typeUpdates } = await quiet(() =>
    priceHoldings(
      [holding(), holding({ user_id: "u2" }), holding({ isin: "BAD", yahoo_symbol: "NOPE" }), holding({ isin: "BND", yahoo_symbol: "AGGH", asset_type: "Bond" })],
      async (symbol) => {
        quotes++;
        if (symbol === "NOPE") throw Object.assign(new Error("No valid price"), { name: "HoldingError" });
        return { price: 100, currency: "USD", assetType: "ETF" };
      },
      async () => 0.9,
      "2026-11-06",
    )
  );
  assertEquals(quotes, 3);
  assertEquals(rows.map((r) => [r.user_id, r.isin, r.value_native, r.value_eur]), [["u1", "IE00", 200, 180], ["u2", "IE00", 200, 180], ["u1", "BND", 200, 180]]);
  assertEquals(typeUpdates, [{ user_id: "u1", isin: "IE00", asset_type: "ETF" }, { user_id: "u2", isin: "IE00", asset_type: "ETF" }]);
  assertEquals([nextAssetType("Bond", "ETF"), nextAssetType("Stock", "ETF"), nextAssetType(null, "ETF")], ["Bond", "ETF", "ETF"]);
});

Deno.test("crypto rows: USD value converted to EUR, a coin without a price skipped", async () => {
  const rows = await quiet(async () =>
    cryptoRows(
      [
        { user_id: "u1", asset_symbol: "BTC", amount: 0.5, source: "Ledger", coingecko_id: "bitcoin" },
        { user_id: "u1", asset_symbol: "XXX", amount: 3, source: "Ledger", coingecko_id: "gone" },
      ],
      { bitcoin: { usd: 60000 }, gone: { usd: 0 } },
      0.9,
      "2026-11-06",
    )
  );
  assertEquals(rows, [{ user_id: "u1", asset_symbol: "BTC", source: "Ledger", snapshot_date: "2026-11-06", amount: 0.5, price_usd: 60000, value_usd: 30000, value_eur: 27000 }]);
});

function fxDb(hasHistory: boolean) {
  const upserts: unknown[][] = [];
  const db = {
    from: () => {
      const q = {
        select: () => q,
        lt: () => q,
        limit: async () => ({ data: hasHistory ? [{ date: "2026-07-01" }] : [], error: null }),
        upsert: async (rows: unknown[]) => (upserts.push(rows), { error: null }),
      };
      return q;
    },
  };
  return { db, upserts };
}
const fakeGet = (urls: string[]): GetJson => async (url) => {
  urls.push(url);
  return url.includes("latest")
    ? { date: "2026-11-06", rates: { USD: 1.25 } }
    : { start_date: "2026-07-29", rates: { "2026-07-29": { USD: 1.2 }, "2026-07-30": { USD: 1.1 } } };
};

Deno.test("fx: latest rates every run, plus 100 days of history only on a fresh install", async () => {
  const fresh = fxDb(false);
  const urls: string[] = [];
  assertEquals(await syncFx(fresh.db, fakeGet(urls)), 6);
  assertEquals(urls.length, 2);
  assertEquals(fresh.upserts[1], [{ date: "2026-11-06", currency: "EUR", rate_to_eur: 1 }, { date: "2026-11-06", currency: "USD", rate_to_eur: 0.8 }]);

  const existing = fxDb(true);
  const urls2: string[] = [];
  assertEquals(await syncFx(existing.db, fakeGet(urls2)), 2);
  assertEquals(urls2, ["https://api.frankfurter.dev/v1/latest?base=EUR"]);
});

Deno.test("stops pricing holdings once the time is up", async () => {
  let checks = 0;
  const { rows } = await quiet(() =>
    priceHoldings([holding({ isin: "A", yahoo_symbol: "A" }), holding({ isin: "B", yahoo_symbol: "B" })], async () => ({ price: 1, currency: "EUR", assetType: "ETF" }), async () => 1, "2026-11-06", () => checks++ < 1)
  );
  assertEquals(rows.map((r) => r.isin), ["A"]);
});
