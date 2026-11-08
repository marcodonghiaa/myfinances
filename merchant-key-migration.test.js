const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = read('supabase/migrations/20261119000000_merchant_key.sql');
const down = read('supabase/rollbacks/20261119000000_merchant_key.down.sql');
const prev = read('supabase/migrations/20261111000000_manual_transactions.sql');

test('users cannot rewrite merchant_key once set', () => {
  assert.match(up, /new\.merchant_key is not null and new\.merchant_key is distinct from old\.merchant_key/);
  assert.match(up, /alter table public\.transactions add column merchant_key text;/);
  assert.match(up, /alter table public\.merchant_aliases add column merchant_key text;/);
});

test('rollback restores the previous trigger body', () => {
  const body = (s) => s.slice(s.indexOf('create or replace function public.restrict_transaction_updates'), s.indexOf('$function$;') + 11);
  assert.strictEqual(body(down), body(prev));
  assert.doesNotMatch(body(down), /merchant_key/);
});
