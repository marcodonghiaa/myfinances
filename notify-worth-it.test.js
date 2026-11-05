const test = require('node:test');
const assert = require('node:assert');
const { fetchEligibleTransactions } = require('./notify-worth-it');

// Records every builder call as [method, ...args]; awaiting it resolves { data: [], error: null }.
function fakeSupabase() {
  const calls = [];
  const builder = new Proxy({}, {
    get: (_, method) => {
      if (method === 'then') return (resolve) => resolve({ data: [], error: null });
      return (...args) => {
        calls.push([method, ...args]);
        return builder;
      };
    },
  });
  return { supabase: builder, calls };
}

const NOW = new Date('2026-10-27T12:00:00Z');

test('keeps the created_at 3h-24h window', async () => {
  const { supabase, calls } = fakeSupabase();

  await fetchEligibleTransactions(supabase, 'user', NOW);

  assert.deepStrictEqual(calls.find((c) => c[0] === 'lte' && c[1] === 'created_at'), ['lte', 'created_at', '2026-10-27T09:00:00.000Z']);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'gte' && c[1] === 'created_at'), ['gte', 'created_at', '2026-10-26T12:00:00.000Z']);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'eq' && c[1] === 'user_id'), ['eq', 'user_id', 'user']);
});

test('floors booking_date at now - 7 days, null booking_date still passes', async () => {
  const { supabase, calls } = fakeSupabase();

  await fetchEligibleTransactions(supabase, 'user', NOW);

  assert.deepStrictEqual(calls.find((c) => c[0] === 'or'), ['or', 'booking_date.gte.2026-10-20,booking_date.is.null']);
});

test('booking-date floor uses the UTC date', async () => {
  const { supabase, calls } = fakeSupabase();

  await fetchEligibleTransactions(supabase, 'user', new Date('2026-10-27T23:30:00-05:00'));

  assert.deepStrictEqual(calls.find((c) => c[0] === 'or'), ['or', 'booking_date.gte.2026-10-21,booking_date.is.null']);
});

const { userIdsWithSubscriptions, notifyUser } = require('./notify-worth-it');

// Regression: prompts went only to USER_ID; other users with notifications on never got any.
test('every user with a push subscription is prompted, each once', async () => {
  const supabase = {
    from: () => ({
      select: async () => ({ data: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'a' }], error: null }),
    }),
  };
  assert.deepStrictEqual(await userIdsWithSubscriptions(supabase), ['a', 'b']);
});

test('a user with nothing to prompt sends nothing', async () => {
  const sent = [];
  const supabase = {
    from: () => {
      const q = {
        select: () => q, eq: () => q, gte: () => q, is: () => q, or: () => q, in: () => q, not: () => q,
        neq: () => q, lt: () => q, lte: () => q, gt: () => q, order: () => q, limit: () => q,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return q;
    },
  };
  const push = { fetchSubscriptions: async () => [{}], sendToAllSubscriptions: async () => sent.push(1) };
  assert.strictEqual(await notifyUser(supabase, 'a', push), 0);
  assert.deepStrictEqual(sent, []);
});

// Regression: refunded or deleted charges still got a "worth it?" prompt.
test('refunded, deleted and transfer rows are not prompted', async () => {
  const rows = [
    { entry_reference: 'ok', flow_type: 'spend', deleted_at: null },
    { entry_reference: 'new', flow_type: null, deleted_at: null },
    { entry_reference: 'refunded', flow_type: 'refunded', deleted_at: null },
    { entry_reference: 'deleted', flow_type: 'spend', deleted_at: '2026-10-27T10:00:00Z' },
    { entry_reference: 'transfer', flow_type: 'transfer', deleted_at: null },
  ];
  const builder = new Proxy({}, {
    get: (_, m) => (m === 'then' ? (resolve) => resolve({ data: rows, error: null }) : () => builder),
  });
  const got = await fetchEligibleTransactions(builder, 'user', NOW);
  assert.deepStrictEqual(got.map((t) => t.entry_reference), ['ok', 'new']);
});
