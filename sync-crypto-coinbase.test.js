const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SECRET_KEY ||= 'test';
const { fetchAllAccounts } = require('./sync-crypto-coinbase');

// Regression: only the first page (about 49 accounts) was read, so coins past it kept stale amounts.
test('follows the cursor until the last page', async () => {
  const pages = {
    '': { accounts: [{ id: 1 }, { id: 2 }], has_next: true, cursor: 'c2' },
    c2: { accounts: [{ id: 3 }], has_next: true, cursor: 'c3' },
    c3: { accounts: [{ id: 4 }], has_next: false, cursor: '' },
  };
  const asked = [];
  const accounts = await fetchAllAccounts(async (cursor) => (asked.push(cursor), pages[cursor ?? '']));
  assert.deepStrictEqual(accounts.map((a) => a.id), [1, 2, 3, 4]);
  assert.deepStrictEqual(asked, [null, 'c2', 'c3']);
});

test('a cursor that repeats ends the walk instead of looping', async () => {
  let calls = 0;
  const accounts = await fetchAllAccounts(async () => (calls++, { accounts: [{ id: calls }], has_next: true, cursor: 'same' }));
  assert.strictEqual(calls, 2);
  assert.strictEqual(accounts.length, 2);
});
