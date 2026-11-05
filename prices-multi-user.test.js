const test = require('node:test');
const assert = require('node:assert');

// The scripts build a client when loaded; a dummy one is enough here.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SECRET_KEY ||= 'test';
const { priceHoldings } = require('./sync-portfolio-prices');
const { cryptoRows } = require('./sync-crypto-prices');

// Regression: prices were fetched only for USER_ID, so another user's holdings kept the one
// price add-holding wrote on the day they were added.
test('every user gets a snapshot for their own holding, under their own id', async () => {
  const getQuote = async () => ({ price: 10, currency: 'EUR', assetType: null });
  const { rows } = await priceHoldings(
    [
      { user_id: 'a', isin: 'IE1', yahoo_symbol: 'VWCE.DE', shares: 2, asset_type: 'ETF' },
      { user_id: 'b', isin: 'IE1', yahoo_symbol: 'VWCE.DE', shares: 5, asset_type: 'ETF' },
    ],
    getQuote,
    async () => 1,
    '2026-11-05',
  );
  assert.deepStrictEqual(
    rows.map((r) => [r.user_id, r.value_eur]),
    [['a', 20], ['b', 50]],
  );
});

test('a symbol several users hold is fetched once', async () => {
  let calls = 0;
  const getQuote = async () => {
    calls++;
    return { price: 1, currency: 'USD', assetType: null };
  };
  await priceHoldings(
    [
      { user_id: 'a', isin: 'X', yahoo_symbol: 'AAPL', shares: 1 },
      { user_id: 'b', isin: 'X', yahoo_symbol: 'AAPL', shares: 1 },
    ],
    getQuote,
    async () => 0.9,
    '2026-11-05',
  );
  assert.strictEqual(calls, 1);
});

test('a holding that fails to price is skipped, the others are kept', async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    const getQuote = async (symbol) => {
      if (symbol === 'BAD') throw new Error('Yahoo error 404');
      return { price: 3, currency: 'EUR', assetType: null };
    };
    const { rows } = await priceHoldings(
      [
        { user_id: 'a', isin: 'B', yahoo_symbol: 'BAD', shares: 1 },
        { user_id: 'b', isin: 'G', yahoo_symbol: 'GOOD', shares: 1 },
      ],
      getQuote,
      async () => 1,
      '2026-11-05',
    );
    assert.deepStrictEqual(rows.map((r) => r.user_id), ['b']);
  } finally {
    console.error = errors;
  }
});

test('crypto snapshots carry each holding user', () => {
  const rows = cryptoRows(
    [
      { user_id: 'a', asset_symbol: 'BTC', source: 'Manual', amount: 1, coingecko_id: 'bitcoin' },
      { user_id: 'b', asset_symbol: 'BTC', source: 'Ledger', amount: 2, coingecko_id: 'bitcoin' },
    ],
    { bitcoin: { usd: 100 } },
    0.5,
    '2026-11-05',
  );
  assert.deepStrictEqual(
    rows.map((r) => [r.user_id, r.value_eur]),
    [['a', 50], ['b', 100]],
  );
});
