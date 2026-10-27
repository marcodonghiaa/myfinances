const test = require('node:test');
const assert = require('node:assert');
const { syncAccountBalance } = require('./sync-networth');

const EB = 'https://api.enablebanking.com/accounts';
const BALANCES = { balances: [{ balance_amount: { amount: '12.50', currency: 'EUR' } }] };

// Answers by URL suffix; records every URL called.
function fakeFetch(responses) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const key = Object.keys(responses).find((suffix) => url.endsWith(suffix));
    assert.ok(key, `unexpected URL ${url}`);
    const res = responses[key];
    return { ok: true, status: 200, ...res, json: async () => res.body };
  };
  return { fetch, urls };
}

// Records .from(t).update(patch).eq(col, val).
function fakeSupabase(error = null) {
  const updates = [];
  const supabase = {
    from: (table) => ({
      update: (patch) => ({
        eq: async (col, val) => {
          updates.push({ table, patch, col, val });
          return { error };
        },
      }),
    }),
  };
  return { supabase, updates };
}

test('calls EB with eb_account_uid and saves under uid', async () => {
  const { fetch, urls } = fakeFetch({ '/balances': { body: BALANCES } });
  const { supabase } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h' };

  const { row, rejected } = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(urls, [`${EB}/eb/balances`]);
  assert.strictEqual(row.account_uid, 'pk');
  assert.strictEqual(row.amount, 12.5);
  assert.strictEqual(rejected, null);
});

test('fills a missing hash once, then fetches the balance', async () => {
  const { fetch, urls } = fakeFetch({
    '/details': { body: { identification_hash: 'h', account_id: { iban: 'IT1' } } },
    '/balances': { body: BALANCES },
  });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: null };

  const { row } = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(urls, [`${EB}/eb/details`, `${EB}/eb/balances`]);
  assert.deepStrictEqual(updates, [
    { table: 'accounts', patch: { identification_hash: 'h', iban: 'IT1' }, col: 'uid', val: 'pk' },
  ]);
  assert.strictEqual(row.account_uid, 'pk');
});

test('a 429 on details still saves the balance', async () => {
  const { fetch } = fakeFetch({
    '/details': { ok: false, status: 429 },
    '/balances': { body: BALANCES },
  });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: null };

  const { row } = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(updates, []);
  assert.notStrictEqual(row, null);
});

test('a 404 on balances is reported as rejected', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 404 } });
  const { supabase } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h' };

  const result = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(result, { row: null, rejected: 404 });
});

test('a bank id already used by another row (23505) still saves the balance', async () => {
  const { fetch } = fakeFetch({
    '/details': { body: { identification_hash: 'h', account_id: { iban: 'IT1' } } },
    '/balances': { body: BALANCES },
  });
  const { supabase, updates } = fakeSupabase({ code: '23505' });
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: null };
  const { row, rejected } = await syncAccountBalance({ fetch, supabase }, 'tok', account, 'user', '2026-10-27');
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(row.account_uid, 'pk');
  assert.strictEqual(rejected, null);
});
