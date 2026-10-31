const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { parseYahooHistory, parseCoinGeckoHistory, historyTargets, getJson, backfillPriceHistory } = require('./price-history');

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 26) / 1000; // 2026-10-26 00:00 UTC
const yahoo = (timestamp, close, meta = { currency: 'USD', gmtoffset: 0 }) => ({
  chart: { result: [{ meta, timestamp, indicators: { quote: [{ close }] } }] },
});

test('Yahoo: closes become one row per day, null and non-positive candles are skipped', () => {
  const { currency, rows } = parseYahooHistory(yahoo([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY], [10, null, 0, 12]), '2026-11-01');
  assert.strictEqual(currency, 'USD');
  assert.deepStrictEqual(rows, [{ price_date: '2026-10-26', price: 10 }, { price_date: '2026-10-29', price: 12 }]);
});

test("Yahoo: today's candle is a live quote and is dropped", () => {
  const { rows } = parseYahooHistory(yahoo([T0, T0 + DAY], [10, 11]), '2026-10-27');
  assert.deepStrictEqual(rows.map((r) => r.price_date), ['2026-10-26']);
});

test('Yahoo: London pence become pounds', () => {
  const { currency, rows } = parseYahooHistory(yahoo([T0], [250], { currency: 'GBp', gmtoffset: 0 }), '2026-11-01');
  assert.strictEqual(currency, 'GBP');
  assert.strictEqual(rows[0].price, 2.5);
});

test("Yahoo: the day is the exchange's own (gmtoffset), not UTC", () => {
  // 2026-10-26 22:00 UTC is already the 27th in Tokyo
  const { rows } = parseYahooHistory(yahoo([T0 + 22 * 3600], [10], { currency: 'JPY', gmtoffset: 32400 }), '2026-11-01');
  assert.strictEqual(rows[0].price_date, '2026-10-27');
});

test('Yahoo: two candles on one day keep one row (a duplicate would fail the whole upsert)', () => {
  const { rows } = parseYahooHistory(yahoo([T0, T0 + 3600], [10, 11]), '2026-11-01');
  assert.deepStrictEqual(rows, [{ price_date: '2026-10-26', price: 11 }]);
});

test('Yahoo: an error body or missing candles throws', () => {
  assert.throws(() => parseYahooHistory({ chart: { result: null, error: { code: 'Not Found' } } }, '2026-11-01'), /No history/);
  assert.throws(() => parseYahooHistory({ chart: { result: [{ meta: { currency: 'USD' } }] } }, '2026-11-01'), /No history/);
  assert.throws(() => parseYahooHistory(yahoo([T0], [1], {}), '2026-11-01'), /No currency/);
});

test('CoinGecko: daily USD points, today and non-positive prices dropped', () => {
  const ms = (d) => Date.UTC(2026, 9, d);
  const { currency, rows } = parseCoinGeckoHistory({ prices: [[ms(26), 100], [ms(27), 0], [ms(28), 90], [ms(30), 95]] }, '2026-10-30');
  assert.strictEqual(currency, 'USD');
  assert.deepStrictEqual(rows, [{ price_date: '2026-10-26', price: 100 }, { price_date: '2026-10-28', price: 90 }]);
  assert.throws(() => parseCoinGeckoHistory({ status: { error_code: 429 } }, '2026-10-30'), /No history/);
});

test('targets are distinct, non-empty, stocks before coins', () => {
  assert.deepStrictEqual(historyTargets(['AAA', 'AAA', '', null], ['bitcoin', 'bitcoin']), [
    { provider: 'yahoo', symbol: 'AAA' },
    { provider: 'coingecko', symbol: 'bitcoin' },
  ]);
});

const res = (status, body, headers = {}) => ({
  ok: status < 400, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

test('429 waits for Retry-After then succeeds', async () => {
  const waits = [];
  const answers = [res(429, {}, { 'retry-after': '7' }), res(200, { ok: 1 })];
  const out = await getJson('u', {}, { fetch: async () => answers.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepStrictEqual(out, { ok: 1 });
  assert.deepStrictEqual(waits, [7000]);
});

test('429 forever gives up with a status, after backing off more each time', async () => {
  const waits = [];
  await assert.rejects(
    getJson('u', {}, { fetch: async () => res(429, {}), sleep: async (ms) => waits.push(ms) }),
    (err) => err.status === 429,
  );
  assert.strictEqual(waits.length, 3);
  assert.ok(waits[0] < waits[1] && waits[1] < waits[2]);
});

test('a server error is not retried', async () => {
  let calls = 0;
  await assert.rejects(getJson('u', {}, { fetch: async () => (calls++, res(500, {})), sleep: async () => {} }), (err) => err.status === 500);
  assert.strictEqual(calls, 1);
});

// A fake Supabase: tables answer by name, price_history newest dates and upserts are recorded.
function fakeSupabase({ stocks = [], coins = [], newest = {}, tableMissing = false } = {}) {
  const upserts = [];
  const client = {
    upserts,
    from: (table) => {
      const filters = {};
      const q = {
        select: (cols, opts) => { q.head = opts?.head; return q; },
        eq: (k, v) => ((filters[k] = v), q),
        gt: () => q,
        order: () => q,
        limit: () => q,
        upsert: async (rows) => {
          upserts.push({ table, rows });
          return { error: tableMissing ? { code: 'PGRST205' } : null };
        },
        then: (resolve) => {
          if (table === 'portfolio_holdings') return resolve({ data: stocks.map((yahoo_symbol) => ({ yahoo_symbol })), error: null });
          if (table === 'crypto_holdings') return resolve({ data: coins.map((coingecko_id) => ({ coingecko_id })), error: null });
          if (tableMissing) return resolve({ count: null, error: { code: 'PGRST205' } });
          const d = newest[`${filters.provider}:${filters.symbol}`];
          return resolve({ data: d ? [{ price_date: d }] : [], error: null });
        },
      };
      return q;
    },
  };
  return client;
}

const yahooBody = yahoo([T0, T0 + DAY], [10, 11]);
const geckoBody = { prices: [[Date.UTC(2026, 9, 26), 100], [Date.UTC(2026, 9, 27), 101]] };
const route = (answers) => async (url) => {
  const key = Object.keys(answers).find((k) => url.includes(k));
  return answers[key]();
};
const base = { userId: 'u', today: '2026-11-01', userEnv: {}, sleep: async () => {} };

test('fills holdings that have little history and skips complete ones', async () => {
  const supabase = fakeSupabase({ stocks: ['AAA', 'BBB'], coins: ['bitcoin'], newest: { 'yahoo:BBB': '2026-10-31' } });
  const urls = [];
  const out = await backfillPriceHistory({
    ...base, supabase, env: {},
    fetch: async (url) => (urls.push(url), url.includes('yahoo') ? res(200, yahooBody) : res(200, geckoBody)),
  });
  assert.deepStrictEqual({ ...out }, { filled: 2, failed: 0, complete: 1, tableMissing: false });
  assert.strictEqual(urls.length, 2);
  assert.deepStrictEqual(supabase.upserts.map((u) => u.table), ['price_history', 'price_history']);
  assert.deepStrictEqual(supabase.upserts[0].rows[0], { provider: 'yahoo', symbol: 'AAA', currency: 'USD', price_date: '2026-10-26', price: 10 });
  assert.strictEqual(supabase.upserts[1].rows[0].currency, 'USD');
});

test('a holding whose newest price is 3 days old is complete, 4 days old is topped up', async () => {
  const supabase = fakeSupabase({ stocks: ['AAA', 'BBB'], newest: { 'yahoo:AAA': '2026-10-29', 'yahoo:BBB': '2026-10-28' } });
  const out = await backfillPriceHistory({ ...base, supabase, env: {}, fetch: async () => res(200, yahooBody) });
  assert.deepStrictEqual({ ...out }, { filled: 1, failed: 0, complete: 1, tableMissing: false });
});

test('a long Retry-After is capped', async () => {
  const waits = [];
  const answers = [res(429, {}, { 'retry-after': '3600' }), res(200, {})];
  await getJson('u', {}, { fetch: async () => answers.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepStrictEqual(waits, [60000]);
});

test('after the time budget no new symbol is started, the rest count as failed', async () => {
  let t = 0;
  const supabase = fakeSupabase({ stocks: ['AAA', 'BBB', 'CCC'] });
  const out = await backfillPriceHistory({
    ...base, supabase, env: {}, now: () => t,
    fetch: async () => ((t += 5 * 60000), res(200, yahooBody)),
  });
  assert.deepStrictEqual({ ...out }, { filled: 2, failed: 1, complete: 0, tableMissing: false }); // 5 min, 10 min, then over 8
});

test('--force refetches holdings that are complete', async () => {
  const supabase = fakeSupabase({ stocks: ['AAA'], newest: { 'yahoo:AAA': '2026-10-31' } });
  const out = await backfillPriceHistory({ ...base, supabase, env: {}, force: true, fetch: async () => res(200, yahooBody) });
  assert.strictEqual(out.filled, 1);
});

test('one failing symbol does not stop the others', async () => {
  const supabase = fakeSupabase({ stocks: ['AAA', 'BBB'], coins: ['bitcoin'] });
  const out = await backfillPriceHistory({
    ...base, supabase, env: {},
    fetch: async (url) => (url.includes('AAA') ? res(404, {}) : url.includes('yahoo') ? res(200, yahooBody) : res(200, geckoBody)),
  });
  assert.deepStrictEqual({ ...out }, { filled: 2, failed: 1, complete: 0, tableMissing: false });
});

test('calls to one provider are spaced, the first is not delayed', async () => {
  const waits = [];
  const supabase = fakeSupabase({ stocks: ['AAA', 'BBB'], coins: ['bitcoin', 'ethereum'] });
  await backfillPriceHistory({
    ...base, supabase, env: {}, sleep: async (ms) => waits.push(ms),
    fetch: async (url) => (url.includes('yahoo') ? res(200, yahooBody) : res(200, geckoBody)),
  });
  assert.strictEqual(waits.length, 2); // second Yahoo call, second CoinGecko call
});

test('the demo key is sent to CoinGecko only when set', async () => {
  const seen = [];
  const run = (env) => backfillPriceHistory({
    ...base, supabase: fakeSupabase({ coins: ['bitcoin'] }), env,
    fetch: async (url, opts) => (seen.push(opts.headers), res(200, geckoBody)),
  });
  await run({});
  await run({ COINGECKO_DEMO_API_KEY: 'k' });
  assert.strictEqual(seen[0]['x-cg-demo-api-key'], undefined);
  assert.strictEqual(seen[1]['x-cg-demo-api-key'], 'k');
});

test('a missing price_history table (migration not applied) is reported before any fetch', async () => {
  const out = await backfillPriceHistory({ ...base, supabase: fakeSupabase({ stocks: ['AAA'], tableMissing: true }), env: {}, fetch: async () => { throw new Error('no call expected'); } });
  assert.strictEqual(out.tableMissing, true);
  assert.strictEqual(out.failed, 0);
});

test('no holdings: nothing to do', async () => {
  const out = await backfillPriceHistory({ ...base, supabase: fakeSupabase(), env: {}, fetch: async () => { throw new Error('no call expected'); } });
  assert.deepStrictEqual({ ...out }, { filled: 0, failed: 0, complete: 0, tableMissing: false });
});

test('past prices go to price_history only, never into the net worth snapshot tables', () => {
  for (const file of ['price-history.js', 'backfill-price-history.js']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /from\('(portfolio|crypto)_snapshots'\)/, file);
  }
});
