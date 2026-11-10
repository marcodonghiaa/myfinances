const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/--.*$/gm, '');
const code = read('supabase/migrations/20261205000000_lock_refund_of.sql');
const down = read('supabase/rollbacks/20261205000000_lock_refund_of.down.sql');
const previous = read('supabase/migrations/20261128000000_transfer_detection.sql');
const fnOf = (sql) => sql.slice(sql.indexOf('create or replace function public.restrict_transaction_updates'), sql.indexOf('$function$;') + 11);

// protects=refund_of is written only by the refund pairing (service role): a signed-in user can't
// set it, so a hostile value can't break pairing for everyone or pair a credit with any charge;
// fails_when=users can still change refund_of
test('a signed-in user cannot change refund_of', () => {
  assert.match(code, /or new\.refund_of is distinct from old\.refund_of/);
});

// Same guard as before plus one line: nothing the earlier version protected is dropped.
test('every field the previous guard protected is still protected', () => {
  const before = fnOf(previous).match(/new\.\w+ is distinct from old\.\w+/g);
  const after = fnOf(code).match(/new\.\w+ is distinct from old\.\w+/g);
  assert.deepEqual(after.filter((c) => !c.includes('refund_of')), before);
});

test('the rollback restores the guard without refund_of', () => {
  assert.match(down, /create or replace function public\.restrict_transaction_updates\(\)/);
  assert.doesNotMatch(down, /refund_of/);
  assert.deepEqual(fnOf(down).match(/new\.\w+ is distinct from old\.\w+/g), fnOf(previous).match(/new\.\w+ is distinct from old\.\w+/g));
});
