const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/migrations/20261126000000_raw_without_accounts.sql', 'utf8').replace(/--.*$/gm, '');

test('only the two account keys leave raw, only on rows that have them', () => {
  assert.match(code, /set raw = raw - 'creditor_account' - 'debtor_account'/);
  assert.match(code, /where raw \?\| array\['creditor_account', 'debtor_account'\];/);
  assert.doesNotMatch(code, /set raw = null/i);
});
