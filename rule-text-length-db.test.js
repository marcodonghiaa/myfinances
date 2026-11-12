// Issue #141: rules saved before the 200-character cap must still take changes that leave their
// text alone (income mark, priority re-sort); new or retyped text is still capped. Runs the
// migration and its rollback against real Postgres. Needs psql and RLS_TEST_DATABASE_URL (a
// superuser URL to a throwaway server); skipped without it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const U = 'aaaaaaaa-0000-0000-0000-000000000001';
const db = `rule_text_len_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const CAP_MIGRATION = '20261206000000_rule_match_mode.sql';
const UP = 'supabase/migrations/20261211000000_rule_text_length_on_change.sql';
const DOWN = 'supabase/rollbacks/20261211000000_rule_text_length_on_change.down.sql';

function psql(args) {
  return execFileSync('psql', [dbUrl(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const sql = (s) => psql(['-c', s]);
// pg_net and pg_cron are stubbed by full-schema-shim.sql.
const applySql = (file) =>
  execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
    input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
// As the signed-in owner, through RLS, the way the dashboard writes.
const asOwner = (s) => sql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${U}","role":"authenticated"}'; ${s}; commit;`);
// Verbose, so the error shows its code and CONSTRAINT NAME field (not just the message).
const refused = (s) => {
  try {
    psql(['-v', 'VERBOSITY=verbose', '-c', s]);
    return '';
  } catch (e) {
    return String(e.stderr);
  }
};
const LONG = 'x'.repeat(250);
const CAP = /23514[\s\S]*CONSTRAINT NAME:\s+category_rules_match_text_length/;
const insert = (text) =>
  `insert into public.category_rules (user_id, match_field, match_text, set_category) values ('${U}', 'any', '${text}', 'Food')`;

test('rule text cap only on new or changed text', { skip }, async (t) => {
  execFileSync('psql', [url, '-X', '-q', '-c', `create database ${db}`]);
  t.after(() => execFileSync('psql', [url, '-X', '-q', '-c', `drop database if exists ${db} with (force)`]));
  psql(['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  // The real schema: every migration before 20261206 (the cap), then a rule saved before the cap
  // existed, then the rest up to this one.
  for (const f of MIGRATIONS.filter((f) => f < UP.split('/').pop())) {
    if (f === CAP_MIGRATION) sql(`insert into auth.users (id) values ('${U}'); ${insert(LONG)}`);
    applySql(`supabase/migrations/${f}`);
  }
  assert.strictEqual(sql(`select count(*) from public.category_rules where char_length(match_text) = 250`), '1');

  await t.test('before the fix: an old long rule cannot be marked', () => {
    assert.match(refused(`update public.category_rules set set_income_kind = 'regular' where match_text = '${LONG}'`), CAP);
  });

  await t.test('applies twice', () => {
    psql(['-f', UP]);
    psql(['-f', UP]);
  });

  await t.test('an old long rule takes changes that leave its text alone', () => {
    asOwner(`update public.category_rules set set_income_kind = 'regular', priority = 5 where match_text = '${LONG}'`);
    assert.strictEqual(sql(`select set_income_kind || ':' || priority from public.category_rules where match_text = '${LONG}'`), 'regular:5');
  });

  await t.test('new or retyped text is still capped at 200 characters, and empty is refused', () => {
    assert.match(refused(insert('y'.repeat(201))), CAP);
    assert.match(refused(insert('')), CAP);
    sql(insert('z'.repeat(200)));
    assert.match(refused(`update public.category_rules set match_text = '${LONG}y' where match_text = '${LONG}'`), CAP);
    assert.match(refused(`update public.category_rules set match_text = '' where match_text = '${LONG}'`), CAP);
    // Shortening an old rule is allowed.
    sql(`update public.category_rules set match_text = 'Netflix' where match_text = '${LONG}'`);
  });

  await t.test('refused with check_violation (23514)', () => {
    assert.match(
      refused(`do $$ begin ${insert('y'.repeat(201))}; exception when check_violation then raise exception 'mapped'; end $$`),
      /mapped/,
    );
  });

  await t.test('rollback restores the old check, and the fix re-applies', () => {
    psql(['-f', DOWN]);
    assert.match(refused(insert('y'.repeat(201))), CAP);
    assert.strictEqual(sql("select count(*) from pg_trigger where tgname = 'category_rules_match_text_length'"), '0');
    psql(['-f', UP]);
    assert.match(refused(insert('y'.repeat(201))), CAP);
    assert.strictEqual(sql("select count(*) from pg_constraint where conname = 'category_rules_match_text_length'"), '0');
  });
});
