const test = require('node:test');
const assert = require('node:assert');
const { applyGroupedUpdates } = require('./batch-update');

// Records each UPDATE the way PostgREST would see it: one call per statement.
function fakeSupabase({ failWhen } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, update: null, eq: {}, in: null, is: null };
      const q = {
        update(u) { call.update = u; return q; },
        eq(col, val) { call.eq[col] = val; return q; },
        in(col, vals) {
          if (col === 'entry_reference') call.in = { col, vals };
          else call.guardIn = { col, vals };
          return q;
        },
        is(col, val) { call.is = { col, val }; return q; },
        then(resolve) {
          calls.push(call);
          resolve({ error: failWhen && failWhen(call) ? { code: '42501', message: 'boom' } : null });
        },
      };
      return q;
    },
  };
}

const item = (ref, over = {}) => ({
  account_uid: 'acc1',
  entry_reference: ref,
  update: { category: 'Groceries' },
  guardColumn: 'category',
  ...over,
});

test('rows with the same account and update become one statement', async () => {
  const db = fakeSupabase();
  await applyGroupedUpdates(db, [item('1'), item('2'), item('3')]);
  assert.strictEqual(db.calls.length, 1);
  assert.deepStrictEqual(db.calls[0].in, { col: 'entry_reference', vals: ['1', '2', '3'] });
  assert.deepStrictEqual(db.calls[0].update, { category: 'Groceries' });
  assert.strictEqual(db.calls[0].eq.account_uid, 'acc1');
});

test('only fills empty values: every statement carries the is-null guard', async () => {
  const db = fakeSupabase();
  await applyGroupedUpdates(db, [item('1')]);
  assert.deepStrictEqual(db.calls[0].is, { col: 'category', val: null });
});

test('different values or accounts are separate statements', async () => {
  const db = fakeSupabase();
  await applyGroupedUpdates(db, [
    item('1'),
    item('2', { update: { category: 'Health' } }),
    item('3', { account_uid: 'acc2' }),
  ]);
  assert.strictEqual(db.calls.length, 3);
});

test('large groups are chunked so the request URL stays short', async () => {
  const db = fakeSupabase();
  const items = Array.from({ length: 120 }, (_, i) => item(String(i)));
  await applyGroupedUpdates(db, items);
  assert.deepStrictEqual(db.calls.map((c) => c.in.vals.length), [50, 50, 20]);
});

test('a failed statement is logged by code, never by message, and the others still run', async () => {
  const db = fakeSupabase({ failWhen: (c) => c.update.category === 'Health' });
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await applyGroupedUpdates(db, [item('1', { update: { category: 'Health' } }), item('2')]);
  } finally {
    console.error = original;
  }
  assert.strictEqual(db.calls.length, 2);
  assert.ok(logged.some((l) => l.includes('42501')));
  assert.ok(!logged.some((l) => l.includes('boom')));
});

test('does nothing for an empty list', async () => {
  const db = fakeSupabase();
  await applyGroupedUpdates(db, []);
  assert.strictEqual(db.calls.length, 0);
});

test('guardIn items are guarded by an in-list instead of is-null', async () => {
  const db = fakeSupabase();
  await applyGroupedUpdates(db, [
    item('1', { update: { category: 'Health', category_source: 'rule' }, guardColumn: 'category_source', guardIn: ['ai', 'rule'] }),
  ]);
  assert.strictEqual(db.calls[0].is, null);
  assert.deepStrictEqual(db.calls[0].guardIn, { col: 'category_source', vals: ['ai', 'rule'] });
});
