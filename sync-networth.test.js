const test = require('node:test');
const assert = require('node:assert');
const { syncAccountBalance } = require('./sync-networth');

const EB = 'https://api.enablebanking.com/accounts';
const BALANCES = { balances: [{ balance_amount: { amount: '12.50', currency: 'EUR' } }] };

// Answers by URL suffix; records every URL called. A response may bring its own json().
function fakeFetch(responses) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const key = Object.keys(responses).find((suffix) => url.endsWith(suffix));
    assert.ok(key, `unexpected URL ${url}`);
    const res = responses[key];
    return { ok: true, status: 200, json: async () => res.body, ...res };
  };
  return { fetch, urls };
}

// Records .from(t).update(patch) with its filter chain (.eq / .is), once awaited.
function fakeSupabase(error = null) {
  const updates = [];
  const supabase = {
    from: (table) => ({
      update: (patch) => {
        const filters = [];
        const query = {
          eq: (col, val) => (filters.push(['eq', col, val]), query),
          is: (col, val) => (filters.push(['is', col, val]), query),
          then: (resolve) => {
            updates.push({ table, patch, filters });
            resolve({ error });
          },
        };
        return query;
      },
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
    { table: 'accounts', patch: { identification_hash: 'h', iban: 'IT1' }, filters: [['eq', 'uid', 'pk']] },
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

  assert.deepStrictEqual(result, { row: null, rejected: 404, renewed: false });
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

const EXPIRED = { code: 401, message: 'Session is expired', error: 'EXPIRED_SESSION', detail: null };

test('EXPIRED_SESSION on balances marks the consent as ending today', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, body: EXPIRED } });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until: '2027-03-06T00:00:00+00:00' };

  const result = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(updates, [
    {
      table: 'accounts',
      patch: { consent_valid_until: '2026-10-27' },
      // Compare-and-set: a Renew during the sync changes the date, so this update then matches nothing.
      filters: [['eq', 'uid', 'pk'], ['eq', 'consent_valid_until', '2027-03-06T00:00:00+00:00']],
    },
  ]);
  assert.deepStrictEqual(result, { row: null, rejected: 401, renewed: true });
});

test('a 401 with another error leaves the consent date alone', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, body: { ...EXPIRED, error: 'UNAUTHORIZED' } } });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until: '2027-03-06T00:00:00+00:00' };

  const result = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(updates, []);
  assert.strictEqual(result.rejected, 401);
});

test('EXPIRED_SESSION never moves an earlier consent date later', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, body: EXPIRED } });
  const { supabase, updates } = fakeSupabase();
  for (const consent_valid_until of ['2026-10-27T00:00:00+00:00', '2026-10-01T00:00:00+00:00']) {
    const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until };
    await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');
  }
  assert.deepStrictEqual(updates, []);
});

test('EXPIRED_SESSION with no stored date marks it today', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, body: EXPIRED } });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until: null };

  await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(updates.map((u) => u.patch), [{ consent_valid_until: '2026-10-27' }]);
  assert.deepStrictEqual(updates[0].filters, [['eq', 'uid', 'pk'], ['is', 'consent_valid_until', null]]);
});

test('a 401 body that is not JSON leaves the consent date alone', async () => {
  const notJson = async () => { throw new SyntaxError('Unexpected token'); };
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, json: notJson } });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until: '2027-03-06T00:00:00+00:00' };

  const result = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.deepStrictEqual(updates, []);
  assert.strictEqual(result.rejected, 401);
});

test('a failed renewal update is swallowed and the sync goes on', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, body: EXPIRED } });
  const { supabase, updates } = fakeSupabase({ code: '42501' });
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until: '2027-03-06T00:00:00+00:00' };

  const result = await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');

  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(result, { row: null, rejected: 401, renewed: false });
});

test('an error that is not an all-caps name is not kept as a code', async () => {
  const { fetch } = fakeFetch({ '/balances': { ok: false, status: 401, body: { ...EXPIRED, error: 'bad text <x>' } } });
  const { supabase, updates } = fakeSupabase();
  const account = { uid: 'pk', eb_account_uid: 'eb', identification_hash: 'h', consent_valid_until: null };
  const logged = [];
  const consoleError = console.error;
  console.error = (line) => logged.push(line);
  try {
    await syncAccountBalance({ fetch, supabase }, 't', account, 'user', '2026-10-27');
  } finally {
    console.error = consoleError;
  }
  assert.deepStrictEqual(logged, ['Failed to fetch balance: HTTP 401']);
  assert.deepStrictEqual(updates, []);
});
