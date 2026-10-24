const test = require('node:test');
const assert = require('node:assert');
const { parseQuote, nextAssetType } = require('./yahoo-quote');

const chart = (meta) => ({ chart: { result: [{ meta }] } });

test('parses price, currency and asset type', () => {
  assert.deepStrictEqual(
    parseQuote(chart({ regularMarketPrice: 12.5, currency: 'USD', instrumentType: 'ETF' }), 'VWCE'),
    { price: 12.5, currency: 'USD', assetType: 'ETF' }
  );
});

test('unknown instrument type maps to Other', () => {
  const q = parseQuote(chart({ regularMarketPrice: 1, currency: 'EUR', instrumentType: 'FUTURE' }), 'X');
  assert.strictEqual(q.assetType, 'Other');
});

test('throws when Yahoo omits the price, so no NaN row reaches the upsert', () => {
  assert.throws(() => parseQuote(chart({ currency: 'EUR' }), 'X'), /No valid price for X/);
});

test('throws on a non-finite or non-numeric price', () => {
  assert.throws(() => parseQuote(chart({ regularMarketPrice: 'n/a', currency: 'EUR' }), 'X'), /No valid price/);
  assert.throws(() => parseQuote(chart({ regularMarketPrice: NaN, currency: 'EUR' }), 'X'), /No valid price/);
});

test('throws when the response has no result', () => {
  assert.throws(() => parseQuote({ chart: { result: null, error: { code: 'Not Found' } } }, 'X'), /No quote data for X/);
});

test('a holding set to Bond by hand keeps that label even though Yahoo calls it an ETF', () => {
  assert.strictEqual(nextAssetType('Bond', 'ETF'), 'Bond');
});

test('other labels follow what Yahoo reports', () => {
  assert.strictEqual(nextAssetType('Stock', 'ETF'), 'ETF');
  assert.strictEqual(nextAssetType(null, 'ETF'), 'ETF');
  assert.strictEqual(nextAssetType('ETF', 'ETF'), 'ETF');
});

test('London quotes in pence (GBp) are stored in pounds', () => {
  const data = { chart: { result: [{ meta: { regularMarketPrice: 1234, currency: 'GBp', instrumentType: 'EQUITY' } }] } };
  assert.deepStrictEqual(parseQuote(data, 'VOD.L'), { price: 12.34, currency: 'GBP', assetType: 'Stock' });
});
