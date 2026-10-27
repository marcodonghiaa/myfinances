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
