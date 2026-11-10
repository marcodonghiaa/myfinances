const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SECRET_KEY ||= 'test';
const { classifyAll, resolveFlowType, flowSourceFor, BATCH_SIZE } = require('./classify-flow');

const batch = (n, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ account_uid: 'a', entry_reference: `r${start + i}` }));

// Regression: when updates failed, the same 200 rows came back forever and the sync hung.
test('stops when the same batch comes back instead of looping forever', async () => {
  const errors = console.error;
  console.error = () => {};
  const code = process.exitCode;
  let fetches = 0;
  try {
    const total = await classifyAll(
      async () => {
        fetches++;
        return batch(BATCH_SIZE);
      },
      async () => {},
    );
    assert.strictEqual(fetches, 2);
    assert.strictEqual(total, BATCH_SIZE);
    assert.strictEqual(process.exitCode, 1);
  } finally {
    console.error = errors;
    process.exitCode = code;
  }
});

test('works through full batches until a short one', async () => {
  const pages = [batch(BATCH_SIZE, 0), batch(BATCH_SIZE, BATCH_SIZE), batch(3, 2 * BATCH_SIZE)];
  let applied = 0;
  const total = await classifyAll(async () => pages.shift() ?? [], async (rows) => (applied += rows.length));
  assert.strictEqual(total, 2 * BATCH_SIZE + 3);
  assert.strictEqual(applied, total);
});

test('EXCHANGE and TOPUP are transfers; everything else follows the direction', () => {
  assert.strictEqual(resolveFlowType({ bank_transaction_code: 'EXCHANGE', credit_debit_indicator: 'DBIT' }), 'transfer');
  assert.strictEqual(resolveFlowType({ bank_transaction_code: 'TRANSFER', credit_debit_indicator: 'DBIT' }), 'spend');
  assert.strictEqual(resolveFlowType({ bank_transaction_code: null, credit_debit_indicator: 'CRDT' }), 'income');
});

// A learned Transfer still leaves spending now that learnedUpdate no longer writes the flow.
test('a Transfer category from your rules or past choices is a transfer; the AI\'s is not', () => {
  const learned = { category: 'Transfer', category_source: 'rule', credit_debit_indicator: 'DBIT' };
  assert.strictEqual(resolveFlowType(learned), 'transfer');
  assert.strictEqual(flowSourceFor(learned), 'rule');
  const ai = { ...learned, category_source: 'ai' };
  assert.strictEqual(resolveFlowType(ai), 'spend');
  assert.strictEqual(flowSourceFor(ai), 'default');
  assert.strictEqual(flowSourceFor({ bank_transaction_code: 'TOPUP' }), 'bank');
});
