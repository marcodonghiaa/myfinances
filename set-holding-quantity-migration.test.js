const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs
  .readFileSync('supabase/migrations/20261112000000_set_holding_quantity.sql', 'utf8')
  .replace(/--.*$/gm, '');

// set_holding_quantity runs as security definer: every read and write must be the caller's own.
test('set_holding_quantity touches only the caller rows', () => {
  assert.match(code, /v_uid uuid := auth\.uid\(\)/);
  assert.match(code, /if v_uid is null then\s+raise exception/);
  for (const stmt of code.match(/(update|select)[^;]*(portfolio|crypto)_(holdings|snapshots)[^;]*;/g)) {
    assert.match(stmt, /user_id = v_uid/, stmt);
  }
  for (const stmt of code.match(/insert into (portfolio|crypto)_snapshots[^;]*;/g)) {
    assert.match(stmt, /values \(v_uid,/, stmt);
  }
});

test('anon cannot call set_holding_quantity', () => {
  assert.match(code, /revoke execute on function public\.set_holding_quantity\([^)]*\) from public, anon;/);
});
