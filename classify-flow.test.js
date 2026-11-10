const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SECRET_KEY ||= 'test';
const { classifyAll, resolveFlowType, flowSourceFor, markRefunds, BATCH_SIZE } = require('./classify-flow');

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

// protects=a refund pair stops counting as spend and income, but never overrides a flow you, a
// rule or a past choice decided; fails_when=candidates or updates ignore flow_source
test('markRefunds pairs only rows whose flow nobody decided (default or legacy)', async () => {
  const candidates = [
    { account_uid: 'a', entry_reference: 'd1', amount: 9.99, currency: 'EUR', credit_debit_indicator: 'DBIT', creditor_name: 'Twitter', booking_date: '2026-10-01' },
    { account_uid: 'a', entry_reference: 'c1', amount: 9.99, currency: 'EUR', credit_debit_indicator: 'CRDT', creditor_name: 'Twitter', booking_date: '2026-10-03' },
  ];
  const filters = [];
  const updates = [];
  const db = {
    from: () => {
      let update = null;
      let refs = null;
      const q = {
        select: () => q,
        is: () => q,
        gte: () => q,
        order: () => q,
        range: async () => ({ data: candidates, error: null }),
        update: (u) => ((update = u), q),
        eq: (col, val) => (update || filters.push([col, val]), q),
        in: (col, vals) => {
          if (col === 'entry_reference') refs = vals;
          else if (update) {
            updates.push({ update, refs, guard: [col, vals] });
            return Promise.resolve({ error: null });
          } else filters.push([col, vals]);
          return q;
        },
      };
      return q;
    },
  };
  assert.strictEqual(await markRefunds(db), 1);
  assert.deepStrictEqual(filters, [['flow_type', ['spend', 'income']], ['flow_source', ['default', 'legacy']]]);
  assert.deepStrictEqual(updates, [
    { update: { flow_type: 'refunded' }, refs: ['d1'], guard: ['flow_source', ['default', 'legacy']] },
    { update: { flow_type: 'refunded', refund_of: 'd1' }, refs: ['c1'], guard: ['flow_source', ['default', 'legacy']] },
  ]);
});
