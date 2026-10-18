const test = require('node:test');
const assert = require('node:assert');
const { parseSpendCsv } = require('./spend-history');

const HEADER = 'month,category,spend\n';

test('maps a month to its first day', () => {
  assert.deepStrictEqual(parseSpendCsv(HEADER + '2024-04,Groceries,120.5\n'), [
    { month: '2024-04-01', category: 'Groceries', spend_eur: 120.5 },
  ]);
});

test('sorts by month then category', () => {
  const rows = parseSpendCsv(HEADER + '2024-05,Health,1\n2024-04,Shopping,1\n2024-04,Groceries,1\n');
  assert.deepStrictEqual(rows.map((r) => `${r.month} ${r.category}`), [
    '2024-04-01 Groceries',
    '2024-04-01 Shopping',
    '2024-05-01 Health',
  ]);
});

test('rejects a bad month with its line number', () => {
  assert.throws(() => parseSpendCsv(HEADER + '2024-00,Health,1\n'), /line 2.*month/);
});

test('rejects an empty category', () => {
  assert.throws(() => parseSpendCsv(HEADER + '2024-04,,1\n'), /line 2.*category/);
});

test('rejects non-numeric or negative spend', () => {
  assert.throws(() => parseSpendCsv(HEADER + '2024-04,Health,abc\n'), /line 2.*spend/);
  assert.throws(() => parseSpendCsv(HEADER + '2024-04,Health,-5\n'), /line 2.*spend/);
});

test('rejects duplicate month and category', () => {
  assert.throws(
    () => parseSpendCsv(HEADER + '2024-04,Health,1\n2024-04,Health,2\n'),
    /duplicate/,
  );
});

test('rejects a wrong header', () => {
  assert.throws(() => parseSpendCsv('a,b\n1,2\n'), /header/);
});
