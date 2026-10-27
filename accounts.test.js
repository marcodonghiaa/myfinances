const test = require('node:test');
const assert = require('node:assert');
const { getAccounts, ebAccountId, idsPatchFromDetails } = require('./accounts');

test('ebAccountId uses eb_account_uid when set', () => {
  assert.strictEqual(ebAccountId({ uid: 'a', eb_account_uid: 'b' }), 'b');
});

test('ebAccountId falls back to uid', () => {
  assert.strictEqual(ebAccountId({ uid: 'a', eb_account_uid: null }), 'a');
  assert.strictEqual(ebAccountId({ uid: 'a' }), 'a');
});

test('idsPatchFromDetails takes hash and iban', () => {
  assert.deepStrictEqual(
    idsPatchFromDetails({ identification_hash: 'h', account_id: { iban: 'IT1' } }),
    { identification_hash: 'h', iban: 'IT1' },
  );
});

test('idsPatchFromDetails takes hash alone when no iban', () => {
  assert.deepStrictEqual(idsPatchFromDetails({ identification_hash: 'h', account_id: {} }), { identification_hash: 'h' });
});

test('idsPatchFromDetails returns null without a hash', () => {
  assert.strictEqual(idsPatchFromDetails({ account_id: { iban: 'IT1' } }), null);
});

test('getAccounts selects the id columns', async () => {
  let selected;
  const supabase = {
    from: () => ({
      select: (cols) => {
        selected = cols;
        return { eq: async () => ({ data: [{ uid: 'a' }], error: null }) };
      },
    }),
  };
  await getAccounts(supabase, 'user');
  for (const col of ['eb_account_uid', 'identification_hash', 'iban']) assert.ok(selected.includes(col), col);
});

test('getAccounts reads without eb_account_uid when the column is missing', async () => {
  const selects = [];
  const responses = [
    { data: null, error: { code: '42703' } },
    { data: [{ uid: 'a' }], error: null },
  ];
  const supabase = {
    from: () => ({
      select: (cols) => {
        selects.push(cols);
        const response = responses[selects.length - 1];
        return { eq: async () => response };
      },
    }),
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepStrictEqual(await getAccounts(supabase, 'user'), [{ uid: 'a' }]);
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(selects.length, 2);
  assert.ok(!selects[1].includes('eb_account_uid'));
});
