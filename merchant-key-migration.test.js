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
  assert.match(fn, /order by created_at desc, source_name/);
  assert.match(fn, /source_name = new\.creditor_name/);
});

test('rename_merchant stores and renames by merchant_key', () => {
  const fn = fnBody(read(aliasesPath), 'rename_merchant');
  assert.match(fn, /insert into merchant_aliases \(user_id, source_name, alias, merchant_key\)/);
  assert.match(fn, /where \(\(v_key is not null and merchant_key = v_key\) or creditor_name = v_source\)/);
  assert.match(fn, /custom_name is null or custom_name = v_old/);
});

test('aggregator keys never drive aliases', () => {
  const sql = read(aliasesPath);
  const apply = fnBody(sql, 'apply_merchant_alias');
  const rename = fnBody(sql, 'rename_merchant');
  assert.match(apply, /new\.merchant_key is not null and new\.merchant_key not in \('paypal', 'apple', 'google'\)/);
  assert.match(rename, /if v_key in \('paypal', 'apple', 'google'\) then\s+v_key := null;\s+end if;/);
  assert.match(rename, /order by created_at desc, source_name/);
  assert.doesNotMatch(sql, /order by created_at desc\s*\n/);
});

test('aliases rollback restores the 20261027 functions and drops the reset trigger', () => {
  const down = read(aliasesDownPath);
  for (const name of ['apply_merchant_alias', 'rename_merchant']) {
    assert.strictEqual(fnBody(down, name), fnBody(aliasesPrev, name), name);
  }
  assert.match(down, /drop trigger trg_reset_merchant_key on public\.transactions;/);
  assert.match(down, /drop function public\.reset_merchant_key\(\);/);
});

const exactPath = 'supabase/migrations/20261119000002_alias_exact_first.sql';
const exactDownPath = 'supabase/rollbacks/20261119000002_alias_exact_first.down.sql';

test('apply_merchant_alias tries the exact source_name before the key', () => {
  const fn = fnBody(read(exactPath), 'apply_merchant_alias');
  const exact = fn.indexOf('source_name = new.creditor_name');
  const byKey = fn.indexOf('merchant_key = new.merchant_key');
  assert.ok(exact > 0 && byKey > exact, 'exact match comes first');
  assert.match(fn, /new\.custom_name is null and new\.merchant_key is not null and new\.merchant_key not in \('paypal', 'apple', 'google'\)/);
  assert.match(fn, /order by created_at desc, source_name/);
  assert.match(fn, /language plpgsql security definer set search_path = public/);
});

// protects=renaming never deletes another name's alias; fails_when=two names of one vendor share a key and one alias is lost
test('rename_merchant upserts only the clicked name and deletes no other alias', () => {
  const fn = fnBody(read(exactPath), 'rename_merchant');
  assert.match(fn, /on conflict \(user_id, source_name\) do update\s+set alias = excluded\.alias, merchant_key = excluded\.merchant_key, created_at = now\(\)/);
  assert.doesNotMatch(fn, /delete from merchant_aliases\s+where user_id = auth\.uid\(\) and \(merchant_key = v_key/);
  assert.match(fn, /delete from merchant_aliases where user_id = auth\.uid\(\) and source_name = v_source;/);
  assert.match(fn, /where \(\(v_key is not null and merchant_key = v_key\) or creditor_name = v_source\)/);
  assert.match(fn, /custom_name is null or custom_name = v_old/);
  assert.match(fn, /language plpgsql set search_path = public/);
});

test('exact-first rollback restores the 20261119000001 functions', () => {
  const down = read(exactDownPath);
  const prev = read(aliasesPath);
  for (const name of ['apply_merchant_alias', 'rename_merchant']) {
    assert.strictEqual(fnBody(down, name), fnBody(prev, name), name);
  }
});
