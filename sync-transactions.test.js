const test = require('node:test');
const assert = require('node:assert');
const { syncAccountTransactions } = require('./sync-transactions');

const EB = 'https://api.enablebanking.com/accounts';
const TX = {
  entry_reference: 'r1',
  transaction_amount: { amount: '-3.20', currency: 'EUR' },
  credit_debit_indicator: 'DBIT',
  booking_date: '2026-10-26',
  value_date: '2026-10-26',
};

// Answers by URL substring; records every URL called.
function fakeFetch(responses) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const key = Object.keys(responses).find((part) => url.includes(part));
    assert.ok(key, `unexpected URL ${url}`);
    const res = responses[key];
    return { ok: true, status: 200, ...res, json: async () => res.body };
  };
  return { fetch, urls };
}

// Records .from(t).upsert(rows, opts).
function fakeSupabase(error = null) {
  const upserts = [];
  const supabase = {
    from: (table) => ({
      upsert: async (rows, opts) => {
        upserts.push({ table, rows, opts });
        return { error };
      },
    }),
  };
  return { supabase, upserts };
}

test('calls EB with eb_account_uid; rows and cursor use uid', async () => {
  const { fetch, urls } = fakeFetch({ '/transactions?': { body: { transactions: [TX] } } });
  const { supabase, upserts } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb' };
  const lastSync = {};

  const result = await syncAccountTransactions({ fetch, supabase }, 't', account, 'user', lastSync, '2026-10-27');

  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].startsWith(`${EB}/eb/transactions?`));
  assert.strictEqual(upserts.length, 1);
  assert.deepStrictEqual(upserts[0].opts, { onConflict: 'account_uid,entry_reference' });
  assert.ok(upserts[0].rows.every((row) => row.account_uid === 'pk'));
  assert.deepStrictEqual(lastSync, { pk: '2026-10-27' });
  assert.deepStrictEqual(result, { upserted: 1, rejected: null });
});

test('date_from uses the uid cursor', async () => {
  const { fetch, urls } = fakeFetch({ '/transactions?': { body: { transactions: [] } } });
  const { supabase } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb' };

  const lastSync = { pk: '2026-10-20' };
  await syncAccountTransactions({ fetch, supabase }, 't', account, 'user', lastSync, '2026-10-27');

  assert.ok(urls[0].includes('date_from=2026-10-13'));
  assert.deepStrictEqual(lastSync, { pk: '2026-10-27' }); // no new rows still advances the cursor
});

test('a 404 is rejected and the cursor stays', async () => {
  const { fetch } = fakeFetch({ '/transactions?': { ok: false, status: 404 } });
  const { supabase, upserts } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb' };
  const lastSync = { pk: '2026-10-20' };

  const result = await syncAccountTransactions({ fetch, supabase }, 't', account, 'user', lastSync, '2026-10-27');

  assert.deepStrictEqual(result, { upserted: 0, rejected: 404 });
  assert.deepStrictEqual(upserts, []);
  assert.deepStrictEqual(lastSync, { pk: '2026-10-20' });
});

test('a failed upsert leaves the cursor', async () => {
  const { fetch } = fakeFetch({ '/transactions?': { body: { transactions: [TX] } } });
  const { supabase } = fakeSupabase({ code: '42501' });
  const lastSync = { pk: '2026-10-20' };

  const result = await syncAccountTransactions({ fetch, supabase }, 't', { uid: 'pk' }, 'user', lastSync, '2026-10-27');

  assert.deepStrictEqual(result, { upserted: 0, rejected: null });
  assert.deepStrictEqual(lastSync, { pk: '2026-10-20' });
});
