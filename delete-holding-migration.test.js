const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const sql = fs.readFileSync('supabase/migrations/20261110000000_delete_holding.sql', 'utf8');
const code = sql.replace(/--.*$/gm, '');

// delete_holding runs as security definer, so RLS does not protect anyone: every delete must
// itself be limited to the caller.
test('every delete in delete_holding is limited to the caller', () => {
  const deletes = code.match(/delete from[^;]*;/g);
  assert.ok(deletes.length >= 6);
  for (const d of deletes) assert.match(d, /user_id = v_uid/, d);
});

test('delete_holding refuses a caller who is not signed in', () => {
  assert.match(code, /v_uid uuid := auth\.uid\(\)/);
  assert.match(code, /if v_uid is null then\s+raise exception/);
});

test('anon cannot call delete_holding', () => {
  assert.match(code, /revoke execute on function public\.delete_holding\(text, text, text\) from public, anon;/);
});
