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

// Tiny in-memory transactions table: honors the filters markRefunds and applyGroupedUpdates use
// and applies updates, so the tests check which rows changed, not call shapes.
function memoryDb(rows) {
  return {
    from: () => {
      const filters = [];
      let patch = null;
      const q = {
        select: () => q,
        update: (u) => ((patch = u), q),
        eq: (c, v) => (filters.push((r) => r[c] === v), q),
        in: (c, vs) => (filters.push((r) => vs.includes(r[c])), q),
        is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), q),
        gte: (c, v) => (filters.push((r) => r[c] >= v), q),
        order: () => q,
        range: () => q,
        then(resolve) {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (patch) hit.forEach((r) => Object.assign(r, patch));
          resolve({ data: patch ? null : hit.map((r) => ({ ...r })), error: null });
        },
      };
      return q;
    },
  };
}

const day = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
const pair = (ref, merchant, source, creditSource = source) => [
  { account_uid: 'a', entry_reference: `${ref}-d`, amount: 9.99, currency: 'EUR', credit_debit_indicator: 'DBIT', creditor_name: merchant, booking_date: day(10), flow_type: 'spend', flow_source: source, deleted_at: null },
  { account_uid: 'a', entry_reference: `${ref}-c`, amount: 9.99, currency: 'EUR', credit_debit_indicator: 'CRDT', creditor_name: merchant, booking_date: day(8), flow_type: 'income', flow_source: creditSource, deleted_at: null },
];

// Regression: a merchant with a "not a transfer" rule (flow_source 'rule') lost refund pairing.
test('markRefunds pairs default, rule and legacy rows, never a flow you set', async () => {
  const rows = [...pair('def', 'Shop', 'default'), ...pair('rul', 'PayPal', 'rule'), ...pair('leg', 'Store', 'legacy'), ...pair('usr', 'Cafe', 'default', 'user')];
  assert.strictEqual(await markRefunds(memoryDb(rows)), 3);
  assert.deepStrictEqual(rows.map((r) => [r.entry_reference, r.flow_type, r.refund_of ?? null]), [
    ['def-d', 'refunded', null], ['def-c', 'refunded', 'def-d'],
    ['rul-d', 'refunded', null], ['rul-c', 'refunded', 'rul-d'],
    ['leg-d', 'refunded', null], ['leg-c', 'refunded', 'leg-d'],
    ['usr-d', 'spend', null], ['usr-c', 'income', null],
  ]);
});

test('markRefunds leaves a side that became a transfer after the read', async () => {
  const rows = pair('x', 'Shop', 'default');
  // A rule turns the charge into a transfer right after the candidates are read.
  const db = memoryDb(rows);
  const from = db.from;
  let reads = 0;
  db.from = () => {
    const q = from();
    const then = q.then;
    q.then = (resolve) => then((v) => {
      if (reads++ === 0) Object.assign(rows[0], { flow_type: 'transfer', flow_source: 'rule' });
      resolve(v);
    });
    return q;
  };
  await markRefunds(db);
  assert.deepStrictEqual(rows.map((r) => r.flow_type), ['transfer', 'refunded']);
});
