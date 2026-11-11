// Polish #15: the income-kind migration and its rollback, run for real against Postgres. Needs psql
// and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it. A fresh
// database is created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const U = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `income_kind_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const UP = 'supabase/migrations/20261208000000_income_kind_rules.sql';
const DOWN = 'supabase/rollbacks/20261208000000_income_kind_rules.down.sql';

function psql(args) {
  return execFileSync('psql', [dbUrl(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const sql = (s) => psql(['-c', s]);
const refused = (s) => {
  try {
    sql(s);
    return '';
  } catch (e) {
    return String(e.stderr);
  }
};
const rule = (text, cols, vals) =>
  `insert into public.category_rules (user_id, match_field, match_text${cols}) values ('${U}', 'creditor_name', '${text}'${vals})`;

test('income-kind migration and rollback on a real database', { skip }, async (t) => {
  execFileSync('psql', [url, '-X', '-q', '-c', `create database ${db}`]);
  t.after(() => execFileSync('psql', [url, '-X', '-q', '-c', `drop database if exists ${db} with (force)`]));
  psql(['-f', 'supabase/tests/supabase-shim.sql']);
  // category_rules as it stood before this migration (initial schema + flow and match-mode columns).
  sql(`create table public.category_rules (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id),
    match_field text not null check (match_field in ('creditor_name', 'remittance_info', 'any')),
    match_text text not null,
    set_category text,
    set_transaction_type text check (set_transaction_type in ('Subscription', 'One-time') or set_transaction_type is null),
    priority integer not null default 100,
    created_at timestamptz not null default now());
    alter table public.category_rules add column set_flow_type text check (set_flow_type in ('spend', 'income', 'transfer'));
    insert into auth.users values ('${U}');`);
  psql(['-f', 'supabase/migrations/20261129000000_flow_only_rules.sql']);
  psql(['-f', 'supabase/migrations/20261206000000_rule_match_mode.sql']);
  sql(`${rule('netflix', ', set_category', ", 'Entertainment'")}; ${rule('Mario', ', set_flow_type', ", 'transfer'")}`);

  await t.test('applies twice, and keeps rules made before it', () => {
    psql(['-f', UP]);
    psql(['-f', UP]);
    assert.strictEqual(sql('select count(*) from public.category_rules'), '2');
  });

  await t.test('takes regular or one_off, alone or with another action, and nothing else', () => {
    sql(rule('Acme', ', set_income_kind', ", 'regular'"));
    sql("update public.category_rules set set_income_kind = 'one_off' where match_text = 'netflix'");
    assert.match(refused(rule('X', ', set_income_kind', ", 'weekly'")), /set_income_kind_check/);
    assert.match(refused(rule('Y', '', '')), /at_least_one_action/);
    assert.match(refused("update public.category_rules set set_income_kind = null where match_text = 'Acme'"), /at_least_one_action/);
  });

  await t.test('rollback deletes income-only rules and keeps the rest without their mark', () => {
    psql(['-f', DOWN]);
    assert.strictEqual(sql("select string_agg(match_text || ':' || coalesce(set_category, set_flow_type), ',' order by match_text) from public.category_rules"), 'Mario:transfer,netflix:Entertainment');
    assert.strictEqual(sql("select count(*) from information_schema.columns where table_name = 'category_rules' and column_name = 'set_income_kind'"), '0');
    assert.match(refused(rule('Z', '', '')), /at_least_one_action/);
  });

  await t.test('re-applies after a rollback', () => {
    psql(['-f', UP]);
    sql(rule('Client', ', set_income_kind', ", 'one_off'"));
    assert.strictEqual(sql("select set_income_kind from public.category_rules where match_text = 'Client'"), 'one_off');
  });
});
