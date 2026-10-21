const test = require('node:test');
const assert = require('node:assert');
const { planHoldings } = require('./coinbase-holdings');

const account = (currency, value, over = {}) => ({ currency, name: `${currency} Wallet`, available_balance: { value }, ...over });

test('a funded, mapped account becomes a holding row', () => {
  const { rows, zeroed } = planHoldings([account('USDC', '12.5')], 'u1');
  assert.deepStrictEqual(rows, [
    { user_id: 'u1', asset_symbol: 'USDC', name: 'USDC Wallet', amount: 12.5, source: 'Coinbase', coingecko_id: 'usd-coin' },
  ]);
  assert.deepStrictEqual(zeroed, []);
});

test('a mapped account that reports exactly zero is listed to be zeroed, not written as a row', () => {
  const { rows, zeroed } = planHoldings([account('BTC', '0'), account('ETH', '0.00000000')], 'u1');
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(zeroed, ['BTC', 'ETH']);
});

test('a malformed balance is skipped, never treated as zero', () => {
  const { rows, zeroed } = planHoldings([account('BTC', 'oops'), account('ETH', undefined, { available_balance: undefined })], 'u1');
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(zeroed, []);
});

test('an unmapped currency is neither written nor zeroed', () => {
  const { rows, zeroed, unmapped } = planHoldings([account('DOGE', '5'), account('SOL', '0')], 'u1');
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(zeroed, []);
  assert.deepStrictEqual(unmapped, ['DOGE']);
});
