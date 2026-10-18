const test = require('node:test');
const assert = require('node:assert');
const { parseHistoryCsv } = require('./net-worth-history');

const HEADER = 'month,stocks,bonds,crypto,cash,total\n';

test('maps a month to its last day and derives liabilities from the gap to total', () => {
  const [row] = parseHistoryCsv(HEADER + '2024-03,257.63,4000,20601.03,1646.71,20505.29\n');
  assert.deepStrictEqual(row, {
    snapshot_date: '2024-03-31',
    stocks_eur: 257.63,
    bonds_eur: 4000,
    crypto_eur: 20601.03,
    cash_eur: 1646.71,
    liabilities_eur: 6000.08,
    total_eur: 20505.29,
  });
});

test('handles leap-year February', () => {
  const [row] = parseHistoryCsv(HEADER + '2024-02,0,0,0,0,0\n');
  assert.strictEqual(row.snapshot_date, '2024-02-29');
});

test('rows come back sorted by date', () => {
  const rows = parseHistoryCsv(HEADER + '2024-05,1,0,0,0,1\n2024-04,1,0,0,0,1\n');
  assert.deepStrictEqual(rows.map((r) => r.snapshot_date), ['2024-04-30', '2024-05-31']);
});

test('rejects a bad month with its line number', () => {
  assert.throws(() => parseHistoryCsv(HEADER + '2024-13,1,0,0,0,1\n'), /line 2.*month/);
});

test('rejects non-numeric values', () => {
  assert.throws(() => parseHistoryCsv(HEADER + '2024-04,#N/A,0,0,0,1\n'), /line 2.*stocks/);
});

test('rejects duplicate months', () => {
  assert.throws(() => parseHistoryCsv(HEADER + '2024-04,1,0,0,0,1\n2024-04,1,0,0,0,1\n'), /duplicate/);
});

test('rejects a wrong header', () => {
  assert.throws(() => parseHistoryCsv('a,b\n1,2\n'), /header/);
});
