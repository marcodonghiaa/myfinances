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

const aliasesPath = 'supabase/migrations/20261119000001_aliases_by_merchant_key.sql';
const aliasesDownPath = 'supabase/rollbacks/20261119000001_aliases_by_merchant_key.down.sql';
const aliasesPrev = read('supabase/migrations/20261027000000_merchant_aliases.sql');
const fnBody = (s, name) => {
  const i = s.indexOf(`function public.${name}(`);
  return s.slice(i, s.indexOf('$$;', i) + 3);
};

test('editing creditor_name drops the stale merchant_key', () => {
  const sql = read(aliasesPath);
  assert.match(sql, /create trigger trg_reset_merchant_key\s+before update of creditor_name on public\.transactions/);
  assert.match(sql, /new\.creditor_name is distinct from old\.creditor_name\s+and new\.merchant_key is not distinct from old\.merchant_key/);
});

test('apply_merchant_alias matches by merchant_key, newest alias first', () => {
  const fn = fnBody(read(aliasesPath), 'apply_merchant_alias');
  assert.match(fn, /merchant_key = new\.merchant_key/);
  assert.match(fn, /order by created_at desc/);
  assert.match(fn, /source_name = new\.creditor_name/);
});

test('rename_merchant stores and renames by merchant_key', () => {
  const fn = fnBody(read(aliasesPath), 'rename_merchant');
  assert.match(fn, /insert into merchant_aliases \(user_id, source_name, alias, merchant_key\)/);
  assert.match(fn, /where \(merchant_key = v_key or \(v_key is null and creditor_name = v_source\)\)/);
  assert.match(fn, /custom_name is null or custom_name = v_old/);
});

test('aliases rollback restores the 20261027 functions and drops the reset trigger', () => {
  const down = read(aliasesDownPath);
  for (const name of ['apply_merchant_alias', 'rename_merchant']) {
    assert.strictEqual(fnBody(down, name), fnBody(aliasesPrev, name), name);
  }
  assert.match(down, /drop trigger trg_reset_merchant_key on public\.transactions;/);
  assert.match(down, /drop function public\.reset_merchant_key\(\);/);
});
