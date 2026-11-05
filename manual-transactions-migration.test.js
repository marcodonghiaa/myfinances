const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs
  .readFileSync('supabase/migrations/20261111000000_manual_transactions.sql', 'utf8')
  .replace(/--.*$/gm, '');
const fn = code.slice(code.indexOf('create function public.add_manual_transaction'));

// add_manual_transaction runs as security definer: it must write only the caller's rows.
test('add_manual_transaction writes rows for the caller only', () => {
  assert.match(fn, /v_uid uuid := auth\.uid\(\)/);
  assert.match(fn, /if v_uid is null then\s+raise exception/);
  assert.match(fn, /where a\.user_id = v_uid and a\.manual/);
  assert.match(fn, /values \(gen_random_uuid\(\), v_uid,/);
  assert.match(fn, /v_ref, v_account, v_uid,/);
});

test('anon cannot call add_manual_transaction', () => {
  assert.match(code, /revoke execute on function public\.add_manual_transaction\([^)]*\) from public, anon;/);
});

test('only manual rows unlock the amount; keys and owner never change', () => {
  const trigger = code.slice(code.indexOf('restrict_transaction_updates'), code.indexOf('create function'));
  assert.match(trigger, /not v_manual and \(\s+new\.amount is distinct from old\.amount/);
  for (const col of ['entry_reference', 'account_uid', 'user_id']) {
    assert.match(trigger, new RegExp(`new\\.${col} is distinct from old\\.${col}\\n`), col);
  }
});
