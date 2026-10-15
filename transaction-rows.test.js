const test = require('node:test');
const assert = require('node:assert');
const { buildRows } = require('./transaction-rows');

const tx = (over = {}) => ({
  entry_reference: 'r1',
  transaction_amount: { amount: '12.50', currency: 'EUR' },
  credit_debit_indicator: 'DBIT',
  booking_date: '2026-10-01',
  remittance_information: ['coffee'],
  ...over,
});

test('keeps bank-provided entry_reference', () => {
  const [row] = buildRows([tx()], 'acc', 'user');
  assert.strictEqual(row.entry_reference, 'r1');
  assert.strictEqual(row.amount, 12.5);
});

test('derives a stable non-null reference when the bank omits it', () => {
  const a = buildRows([tx({ entry_reference: null })], 'acc', 'user')[0].entry_reference;
  const b = buildRows([tx({ entry_reference: undefined })], 'acc', 'user')[0].entry_reference;
  assert.match(a, /^h:[0-9a-f]{24}$/);
  assert.strictEqual(a, b);
});

test('identical reference-less twins stay distinct', () => {
  const rows = buildRows([tx({ entry_reference: null }), tx({ entry_reference: null })], 'acc', 'user');
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(rows[0].entry_reference, rows[1].entry_reference);
});

test('duplicate entry_reference in one batch collapses to one row', () => {
  const rows = buildRows([tx(), tx({ remittance_information: ['later'] })], 'acc', 'user');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].remittance_info, 'later');
});
