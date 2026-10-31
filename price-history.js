const { fetchWithTimeout } = require('./http');
const { errorTag } = require('./log-safe');

// Past market prices for price returns (holding_performance). Written to price_history only: never
// to portfolio_snapshots / crypto_snapshots, which feed the net worth history.

const FRESH_DAYS = 3; // a holding whose newest stored day is older than this (or has none) is fetched again
const MAX_WAIT_MS = 60000; // never obey a Retry-After longer than this
const BUDGET_MS = 8 * 60000; // stop starting new symbols after this; the scheduler kills a script at 10 min
const YAHOO_PACE_MS = 300;
const COINGECKO_PACE_MS = 8000; // the free tier allows only a few calls a minute
const RETRIES = 3;
const RETRY_MS = 20000;
const TABLE_MISSING = new Set(['PGRST205', '42P01']); // migration not applied yet

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const byDate = (rows) => [...new Map(rows.map((r) => [r.price_date, r])).values()]; // one row per day: a duplicate fails the whole upsert

// Yahoo daily closes (not adjusted for dividends: this is price return). Dates are the exchange's
// own day. Today's candle is a live quote the snapshot already covers, so it is dropped.
function parseYahooHistory(data, today) {
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!result || !Array.isArray(result.timestamp) || !Array.isArray(closes)) throw new Error('No history in Yahoo response');
  const meta = result.meta ?? {};
  const pence = meta.currency === 'GBp'; // London listings are quoted in pence; fx_rates has GBP
  const currency = pence ? 'GBP' : meta.currency;
  if (typeof currency !== 'string' || !currency) throw new Error('No currency in Yahoo response');
  const offset = Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : 0;
  const rows = [];
  result.timestamp.forEach((t, i) => {
    const close = closes[i];
    const price_date = dayOf((t + offset) * 1000);
    if (!isPrice(close) || price_date >= today) return;
    rows.push({ price_date, price: pence ? close / 100 : close });
  });
  return { currency, rows: byDate(rows) };
}

// CoinGecko daily points (00:00 UTC) in USD.
function parseCoinGeckoHistory(data, today) {
  if (!Array.isArray(data?.prices)) throw new Error('No history in CoinGecko response');
  const rows = [];
  for (const [ms, price] of data.prices) {
    const price_date = dayOf(ms);
    if (isPrice(price) && price_date < today) rows.push({ price_date, price });
  }
  return { currency: 'USD', rows: byDate(rows) };
}

// The distinct things to fetch, in a stable order.
function historyTargets(stockSymbols, coinIds) {
  const uniq = (list) => [...new Set(list.filter((s) => typeof s === 'string' && s !== ''))];
  return [
    ...uniq(stockSymbols).map((symbol) => ({ provider: 'yahoo', symbol })),
    ...uniq(coinIds).map((symbol) => ({ provider: 'coingecko', symbol })),
  ];
}

// GET json; a 429 waits (Retry-After when sent) and tries again, anything else not ok throws a status.
async function getJson(url, headers, { fetch = fetchWithTimeout, sleep }) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt < RETRIES) {
      const sent = Number(res.headers?.get?.('retry-after'));
      await sleep(Math.min(Number.isFinite(sent) && sent > 0 ? sent * 1000 : RETRY_MS * 2 ** attempt, MAX_WAIT_MS));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error('History request failed'), { status: res.status });
    return res.json();
  }
}

function requestFor({ provider, symbol }, env) {
  const id = encodeURIComponent(symbol);
  if (provider === 'yahoo') {
    return { url: `https://query1.finance.yahoo.com/v8/finance/chart/${id}?interval=1d&range=1y`, headers: { 'User-Agent': 'Mozilla/5.0' } };
  }
  const headers = { Accept: 'application/json' };
  if (env.COINGECKO_DEMO_API_KEY) headers['x-cg-demo-api-key'] = env.COINGECKO_DEMO_API_KEY;
  return { url: `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`, headers };
}

const parsers = { yahoo: parseYahooHistory, coingecko: parseCoinGeckoHistory };
const paceMs = { yahoo: YAHOO_PACE_MS, coingecko: COINGECKO_PACE_MS };

// Fills price_history for the user's current holdings that have too little of it (all with force).
// Soft per symbol: one failure is counted, never thrown. Returns { filled, failed, complete, tableMissing }.
async function backfillPriceHistory({
  supabase, userId, today = dayOf(Date.now()), force = false, env = process.env,
  fetch = fetchWithTimeout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
}) {
  const stocks = await supabase.from('portfolio_holdings').select('yahoo_symbol').eq('user_id', userId).gt('shares', 0);
  if (stocks.error) throw stocks.error;
  const coins = await supabase.from('crypto_holdings').select('coingecko_id').eq('user_id', userId).gt('amount', 0);
  if (coins.error) throw coins.error;
  const targets = historyTargets((stocks.data ?? []).map((r) => r.yahoo_symbol), (coins.data ?? []).map((r) => r.coingecko_id));

  const out = { filled: 0, failed: 0, complete: 0, tableMissing: false };
  // Probe once, with a plain select: a HEAD request on a missing table comes back without its error code.
  const probe = await supabase.from('price_history').select('symbol').limit(1);
  if (TABLE_MISSING.has(probe.error?.code)) return { ...out, tableMissing: true };
  const fresh = dayOf(Date.parse(today) - FRESH_DAYS * 86400000);
  const startedAt = now();
  const called = new Set();
  for (const [i, target] of targets.entries()) {
    try {
      if (now() - startedAt > BUDGET_MS) throw new Error('Time budget used up');
      if (!force) {
        const { data, error } = await supabase.from('price_history').select('price_date')
          .eq('provider', target.provider).eq('symbol', target.symbol).order('price_date', { ascending: false }).limit(1);
        if (error) throw error;
        if ((data?.[0]?.price_date ?? '') >= fresh) { out.complete++; continue; }
      }
      if (called.has(target.provider)) await sleep(paceMs[target.provider]);
      called.add(target.provider);
      const { url, headers } = requestFor(target, env);
      const { currency, rows } = parsers[target.provider](await getJson(url, headers, { fetch, sleep }), today);
      const records = rows.map((r) => ({ provider: target.provider, symbol: target.symbol, currency, ...r }));
      const { error } = await supabase.from('price_history').upsert(records, { onConflict: 'provider,symbol,price_date' }); // a year is at most ~366 rows
      if (error) throw error;
      out.filled++;
    } catch (err) {
      if (TABLE_MISSING.has(err?.code)) return { ...out, tableMissing: true };
      out.failed++;
      console.error(`Price history failed for ${i + 1}/${targets.length}: ${errorTag(err)}`);
    }
  }
  return out;
}

module.exports = { parseYahooHistory, parseCoinGeckoHistory, historyTargets, getJson, backfillPriceHistory };
