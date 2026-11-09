const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const sql = fs.readFileSync('supabase/migrations/20261124000000_sync_all_banks_skip_manual.sql', 'utf8');
const code = sql.replace(/--.*$/gm, '');

// A manual account has no bank: sending it to sync-bank wastes the bank's daily calls and fails.
test('sync_all_banks fans out to bank accounts only', () => {
  assert.match(code, /from public\.accounts a\s+where not a\.manual;/);
});

test('API roles still cannot start a run', () => {
  assert.match(code, /revoke execute on function public\.sync_all_banks\(\) from public, anon, authenticated, service_role;/);
});
