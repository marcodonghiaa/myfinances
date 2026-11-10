const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/migrations/20261210000000_transaction_notes_tags.sql', 'utf8').replace(/--.*$/gm, '');
const rows = fs.readFileSync('transaction-rows.js', 'utf8');

test('sync never writes note or tags, so a re-sync keeps them', () => {
  assert.doesNotMatch(rows, /\bnote\b|\btags\b/);
});

test('note and tags are bounded', () => {
  assert.match(code, /char_length\(note\) between 1 and 2000/);
  assert.match(code, /cardinality\(tags\) <= 20/);
  assert.match(code, /array_position\(tags, null\) is null and array_position\(tags, ''\) is null/);
});

test('view exposes note and tags and keeps security_invoker', () => {
  assert.match(code, /v_transactions_eur with \(security_invoker = true\)/);
  assert.match(code, /t\.refund_of,\s+t\.note,\s+t\.tags\s+from public\.transactions t/);
});

test('tag list reads only the caller\'s rows and is not public', () => {
  assert.match(code, /security invoker/);
  assert.match(code, /t\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(code, /revoke execute on function public\.my_transaction_tags\(\) from public, anon;/);
});
