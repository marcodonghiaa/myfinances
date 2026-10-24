const test = require('node:test');
const assert = require('node:assert');
const { fetchBatchForOneUser, walkNullRows } = require('./user-batch');

// In-memory stand-in for the supabase query builder: honors .is(col, null),
// .eq(col, val) and .limit(n) the way PostgREST does, so the test checks which
// rows come back rather than which calls were made.
function fakeSupabase(rows) {
  return {
    from() {
      const filters = [];
      let max = Infinity;
      const q = {
        select() { return q; },
        is(col, val) { filters.push((r) => r[col] === val); return q; },
        eq(col, val) { filters.push((r) => r[col] === val); return q; },
        not(col, op, val) {
          const ids = val.slice(1, -1).split(',');
          filters.push((r) => !ids.includes(r[col]));
          return q;
        },
        limit(n) { max = n; return q; },
        then(resolve) {
          resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, max), error: null });
        },
      };
      return q;
    },
  };
}

const row = (user_id, ref) => ({ user_id, entry_reference: ref, category: null });
const opts = { select: 'entry_reference', nullColumn: 'category', limit: 40 };

test('returns rows from a single user even when several users have pending rows', async () => {
  const db = fakeSupabase([row('a', '1'), row('b', '2'), row('a', '3'), row('b', '4')]);
  const batch = await fetchBatchForOneUser(db, opts);
  assert.deepStrictEqual(new Set(batch.map((r) => r.user_id)).size, 1);
  assert.strictEqual(batch.length, 2);
});

test('respects the batch limit', async () => {
  const db = fakeSupabase([row('a', '1'), row('a', '2'), row('a', '3')]);
  const batch = await fetchBatchForOneUser(db, { ...opts, limit: 2 });
  assert.strictEqual(batch.length, 2);
});

test('returns an empty array when nothing is pending', async () => {
  const batch = await fetchBatchForOneUser(fakeSupabase([]), opts);
  assert.deepStrictEqual(batch, []);
});

test('throws when the query fails', async () => {
  const failing = { from: () => ({ select: () => ({ is: () => ({ limit: () => Promise.resolve({ data: null, error: new Error('boom') }) }) }) }) };
  await assert.rejects(() => fetchBatchForOneUser(failing, opts), /boom/);
});

test('skips excluded users and serves the next one', async () => {
  const db = fakeSupabase([row('a', '1'), row('b', '2')]);
  const batch = await fetchBatchForOneUser(db, { ...opts, excludeUserIds: new Set(['a']) });
  assert.deepStrictEqual(batch.map((r) => r.user_id), ['b']);
});

test('returns an empty array when every pending user is excluded', async () => {
  const db = fakeSupabase([row('a', '1')]);
  assert.deepStrictEqual(await fetchBatchForOneUser(db, { ...opts, excludeUserIds: new Set(['a']) }), []);
});

test('reads from the table it is given, transactions by default', async () => {
  const seen = [];
  const db = { from(t) { seen.push(t); return fakeSupabase([]).from(); } };
  await fetchBatchForOneUser(db, opts);
  await fetchBatchForOneUser(db, { ...opts, table: 'splitwise_expenses' });
  assert.deepStrictEqual(seen, ['transactions', 'splitwise_expenses']);
});

// Stand-in for the ordered, ranged query walkNullRows makes. Rows the handler fills in
// leave the result set, the way an update to a non-null category does in Postgres.
function rangedStore(rows) {
  return {
    rows,
    from() {
      let nullColumn;
      let range = [0, Infinity];
      const q = {
        select() { return q; },
        is(col) { nullColumn = col; return q; },
        order() { return q; },
        range(from, to) { range = [from, to]; return q; },
        then(resolve) {
          const pending = rows
            .filter((r) => r[nullColumn] === null)
            .sort((a, b) => a.entry_reference.localeCompare(b.entry_reference));
          resolve({ data: pending.slice(range[0], range[1] + 1), error: null });
        },
      };
      return q;
    },
  };
}

test('walkNullRows reaches every row even when filled rows drop out between pages', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const rows = names.map((n, i) => ({ entry_reference: n, category: null, fill: i % 2 === 0 }));
  const seen = [];
  const filled = await walkNullRows(rangedStore(rows), {
    select: '*',
    nullColumn: 'category',
    pageSize: 2,
    handlePage: async (page) => {
      seen.push(...page.map((r) => r.entry_reference));
      const toFill = page.filter((r) => r.fill);
      for (const r of toFill) rows.find((x) => x.entry_reference === r.entry_reference).category = 'X';
      return toFill.length;
    },
  });
  assert.strictEqual(filled, 4);
  assert.deepStrictEqual(seen, names);
});

test('walkNullRows stops on an empty table', async () => {
  const filled = await walkNullRows(rangedStore([]), { select: '*', nullColumn: 'category', handlePage: async () => 0 });
  assert.strictEqual(filled, 0);
});
