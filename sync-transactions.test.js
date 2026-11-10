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

// Records .from(t).upsert(rows, opts); accounts.select(...) answers with ownAccounts.
function fakeSupabase(error = null, ownAccounts = { data: [], error: null }) {
  const upserts = [];
  const accounts = { select: () => accounts, eq: () => accounts, not: async () => ownAccounts };
  const supabase = {
    from: (table) => (table === 'accounts' ? accounts : {
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

// protects=a payment between your own accounts is stored as such, so it counts as a transfer, not
// spend; fails_when=the Node sync stores rows without own_counterparty (parity with the Deno sync)
test('marks a counterparty that is one of your own accounts', async () => {
  const own = { ...TX, entry_reference: 'own', creditor_account: { iban: 'it60 x054 2811 1010 0000 0123 456' } };
  const other = { ...TX, entry_reference: 'other', creditor_account: { iban: 'DE89370400440532013000' } };
  const unknown = { ...TX, entry_reference: 'unknown' };
  const { fetch } = fakeFetch({ '/transactions?': { body: { transactions: [own, other, unknown] } } });
  const { supabase, upserts } = fakeSupabase(null, { data: [{ iban: 'IT60X0542811101000000123456' }], error: null });

  await syncAccountTransactions({ fetch, supabase }, 't', { uid: 'pk' }, 'user', {}, '2026-10-27');

  assert.deepStrictEqual(upserts[0].rows.map((r) => [r.entry_reference, r.own_counterparty]), [
    ['own', true], ['other', false], ['unknown', null],
  ]);
});

test('own accounts unreadable: rows leave own_counterparty out, keeping what was stored', async () => {
  const { fetch } = fakeFetch({ '/transactions?': { body: { transactions: [TX] } } });
  const { supabase, upserts } = fakeSupabase(null, { data: null, error: { code: '42501' } });

  await syncAccountTransactions({ fetch, supabase }, 't', { uid: 'pk' }, 'user', {}, '2026-10-27');

  assert.equal('own_counterparty' in upserts[0].rows[0], false);
});
