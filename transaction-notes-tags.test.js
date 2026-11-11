// Notes and tags (20261208120000_transaction_notes_tags). The row-builder test always runs; the
// database tests need psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server, e.g.
// postgres://postgres@localhost:5432/postgres) and are skipped without it. A fresh database is
// created and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { buildRows } = require('./transaction-rows');

const MIGRATION = 'supabase/migrations/20261208120000_transaction_notes_tags.sql';

// A sample bank transaction as Enable Banking sends it.
const ebTx = (over = {}) => ({
  entry_reference: 'ref-1',
  transaction_amount: { amount: '12.50', currency: 'EUR' },
  credit_debit_indicator: 'DBIT',
  creditor: { name: 'Coffee Bar' },
  remittance_information: ['card'],
  booking_date: '2026-11-02',
  value_date: '2026-11-02',
  status: 'BOOK',
  ...over,
});

// protects=a sync re-run never overwrites the user's note or tags: PostgREST's upsert only sets
// the columns its rows carry; fails_when=the bank row builder starts sending note or tags
test('bank sync rows never carry note or tags', () => {
  for (const ownIbans of [undefined, new Set()]) {
    const [row] = buildRows([ebTx()], 'acc', 'user', ownIbans);
    assert.ok(!('note' in row), 'note');
    assert.ok(!('tags' in row), 'tags');
  }
});

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACC_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const db = `notes_tags_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
// Runs sql as `role` (with user `sub` signed in, if given) inside a rolled-back transaction.
function as(role, sub, q) {
  const claims = sub ? `set local request.jwt.claims = '{"sub":"${sub}"}';` : '';
  try {
    return psql(dbUrl(), ['-c', `begin; set local role ${role}; ${claims} ${q}; rollback;`]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'` : `'${String(v).replace(/'/g, "''")}'`);

// Every migration before this one, in order, on the shims: the real table, its triggers and the
// views built on v_transactions_eur. pg_net and pg_cron are stubbed (see full-schema-shim.sql).
const MIGRATIONS = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const applySql = (file) =>
  execFileSync('psql', [dbUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], {
    input: fs.readFileSync(file, 'utf8').replace(/^create extension if not exists (pg_net|pg_cron).*$/gm, ''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

test('notes and tags on a real Postgres', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql', '-f', 'supabase/tests/full-schema-shim.sql']);
  for (const f of MIGRATIONS.filter((f) => f < MIGRATION.split('/').pop())) applySql(`supabase/migrations/${f}`);
  // Rows written before this migration.
  psql(dbUrl(), [
    '-c',
    `insert into auth.users (id) values ('${A}'), ('${B}');
     insert into public.accounts (uid, user_id, currency) values ('${ACC_A}', '${A}', 'EUR'), ('bbbbbbbb-1111-0000-0000-000000000002', '${B}', 'EUR');
     insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, credit_debit_indicator, booking_date)
     values ('ref-1', '${ACC_A}', '${A}', 12.5, 'EUR', 'DBIT', '2026-11-02'),
            ('ref-2', '${ACC_A}', '${A}', 3, 'EUR', 'DBIT', '2026-11-03'),
            ('ref-b', 'bbbbbbbb-1111-0000-0000-000000000002', '${B}', 9, 'EUR', 'DBIT', '2026-11-03');`,
  ]);
  applySql(MIGRATION);
  const setA = (col, value, ref = 'ref-1') =>
    as('authenticated', A, `update public.transactions set ${col} = ${value} where entry_reference = '${ref}' returning 1`);

  await t.test('existing rows start with no note and no tags', () => {
    assert.strictEqual(psql(dbUrl(), ['-c', "select count(*) from public.transactions where note is null and tags = '{}'"]), '3');
  });

  await t.test('a user writes a note and tags on their own row, and reads them in the view', () => {
    assert.strictEqual(
      as('authenticated', A, `update public.transactions set note = 'Team lunch', tags = '{work,"trip 2026"}' where entry_reference = 'ref-1';
        select note || '|' || array_to_string(tags, ',') from public.v_transactions_eur where entry_reference = 'ref-1'`),
      'Team lunch|work,trip 2026',
    );
  });

  await t.test("a user can't change another user's note or tags", () => {
    assert.strictEqual(as('authenticated', B, `update public.transactions set note = 'x', tags = '{x}' where user_id = '${A}' returning 1`), '');
  });

  await t.test('the database refuses notes and tags the dashboard would never send', () => {
    assert.strictEqual(setA('note', lit('x'.repeat(2000))), '1');
    assert.match(setA('note', lit('x'.repeat(2001))), /transactions_note_length/);
    assert.match(setA('note', "''"), /transactions_note_length/);
    assert.strictEqual(setA('tags', `'{${Array.from({ length: 20 }, (_, i) => `t${i}`)}}'`), '1');
    assert.match(setA('tags', `'{${Array.from({ length: 21 }, (_, i) => `t${i}`)}}'`), /transactions_tags_ok/);
    assert.strictEqual(setA('tags', `array['${'x'.repeat(40)}']`), '1');
    assert.match(setA('tags', `array['${'x'.repeat(41)}']`), /transactions_tags_ok/);
    for (const bad of ["array['']", "array[' trip']", "array['trip ']", "array['a  b']", "array[E'a\\tb']", "array[E'trip\\n']", 'array[null::text]', 'null']) {
      assert.match(setA('tags', bad), /transactions_tags_ok|null value/, bad);
    }
  });

  // polish-1 #2: what counts as a space can't depend on the database's locale (a dump restored
  // elsewhere must still pass), and must match the dashboard, which turns these into plain spaces.
  await t.test('tags with look-alike spaces are refused on any locale', () => {
    for (const cp of ['00A0', '202F', '2007', '3000', '2028', '1680']) {
      const bad = `array[E'work\\u${cp}', E'a\\u${cp}b']`;
      assert.match(setA('tags', bad), /transactions_tags_ok/, cp);
    }
    assert.strictEqual(setA('tags', "array['day trip']"), '1');
  });

  // polish-1 #13: an invisible character alone would make an invisible "#" tag.
  await t.test('tags with zero-width characters are refused', () => {
    for (const cp of ['200B', '200D', '2060', 'FEFF', '00AD']) {
      assert.match(setA('tags', `array[E'\\u${cp}']`), /transactions_tags_ok/, cp);
      assert.match(setA('tags', `array[E'wo\\u${cp}rk']`), /transactions_tags_ok/, cp);
    }
  });

  // polish-1 #11: the dashboard splits on commas and the export joins tags with ", ", so a tag
  // holding a comma would read as two.
  await t.test('tags with a comma are refused', () => {
    assert.match(setA('tags', "array['a,b']"), /transactions_tags_ok/);
    assert.match(setA('tags', "array['trip, work']"), /transactions_tags_ok/);
  });

  // polish-1 #22: "café" typed with a combining accent would otherwise be a second "café" tag.
  await t.test('tags must be in composed (NFC) form', () => {
    assert.strictEqual(setA('tags', "array['café']"), '1');
    assert.match(setA('tags', "array[E'cafe\\u0301']"), /transactions_tags_ok/);
  });

  // polish-1 #20: one row holds a tag once, ignoring case, like the dashboard keeps it.
  await t.test('a row cannot hold the same tag twice', () => {
    assert.match(setA('tags', "array['work', 'work']"), /transactions_tags_ok/);
    assert.match(setA('tags', "array['Work', 'work']"), /transactions_tags_ok/);
    assert.strictEqual(setA('tags', "array['work', 'workshop']"), '1');
  });

  // polish-1 #5: "Trip" on one row and "trip" on another are one suggestion, in the spelling used most.
  await t.test('suggestions merge tags that differ only in case', () => {
    const out = psql(dbUrl(), [
      '-c',
      `begin;
       update public.transactions set tags = '{Trip}' where entry_reference = 'ref-1';
       update public.transactions set tags = '{trip}' where entry_reference = 'ref-2';
       insert into public.transactions (entry_reference, account_uid, user_id, amount, currency, tags)
         values ('ref-3', '${ACC_A}', '${A}', 1, 'EUR', '{trip}');
       set local role authenticated; set local request.jwt.claims = '{"sub":"${A}"}';
       select string_agg(tag || ':' || uses, ',') from public.my_transaction_tags();
       rollback;`,
    ]);
    assert.strictEqual(out, 'trip:3');
  });

  // The proof behind "a sync re-run must not overwrite them": the same upsert PostgREST runs for
  // the bank sync (insert the builder's columns, on conflict update those columns only).
  await t.test('a sync re-run keeps the note and tags', () => {
    const [row] = buildRows([ebTx({ transaction_amount: { amount: '13.25', currency: 'EUR' } })], ACC_A, A, new Set());
    const cols = Object.keys(row);
    const upsert = `insert into public.transactions (${cols.join(', ')}) values (${cols.map((c) => lit(row[c])).join(', ')})
      on conflict (account_uid, entry_reference) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`;
    const out = psql(dbUrl(), [
      '-c',
      `begin;
       update public.transactions set note = 'Team lunch', tags = '{work}' where entry_reference = 'ref-1';
       ${upsert};
       select amount || '|' || note || '|' || array_to_string(tags, ',') from public.transactions where entry_reference = 'ref-1';
       rollback;`,
    ]);
    assert.strictEqual(out, '13.25|Team lunch|work');
  });

  await t.test('tag suggestions: only the caller\'s tags, most used first, deleted rows left out', () => {
    psql(dbUrl(), [
      '-c',
      `update public.transactions set tags = '{work,trip}' where entry_reference = 'ref-1';
       update public.transactions set tags = '{work}' where entry_reference = 'ref-2';
       update public.transactions set tags = '{secret}' where entry_reference = 'ref-b';`,
    ]);
    const list = (sub) => as('authenticated', sub, "select string_agg(tag || ':' || uses, ',') from public.my_transaction_tags()");
    assert.strictEqual(list(A), 'work:2,trip:1');
    assert.strictEqual(list(B), 'secret:1');
    psql(dbUrl(), ['-c', "update public.transactions set deleted_at = now() where entry_reference = 'ref-2'"]);
    assert.strictEqual(list(A), 'trip:1,work:1');
    assert.match(as('anon', null, 'select * from public.my_transaction_tags()'), /permission denied/);
  });

  await t.test('the rollback drops the suggestions and the limits, and keeps what users wrote', () => {
    psql(dbUrl(), ['-1', '-f', 'supabase/rollbacks/20261208120000_transaction_notes_tags.down.sql']);
    assert.match(as('authenticated', A, 'select * from public.my_transaction_tags()'), /does not exist/);
    assert.strictEqual(setA('tags', "array[' loose ']"), '1');
    assert.strictEqual(psql(dbUrl(), ['-c', "select array_to_string(tags, ',') from public.transactions where entry_reference = 'ref-1'"]), 'work,trip');
  });

  // polish-1 #1: UPGRADING's rollback ends with `migration repair --status reverted`, so the next
  // `db push` runs this file again over the kept columns and whatever was written meanwhile.
  await t.test('after the rollback the migration applies again and tidies rows written meanwhile', () => {
    psql(dbUrl(), [
      '-c',
      `update public.transactions set tags = array[' loose  tag ', 'loose tag', '', 'a,b', E'\\u200B', E'cafe\\u0301', 'café'] where entry_reference = 'ref-1';
       update public.transactions set note = '   ' where entry_reference = 'ref-2';`,
    ]);
    applySql(MIGRATION);
    assert.strictEqual(
      psql(dbUrl(), ['-c', "select array_to_string(tags, ',') || '|' || coalesce(note, 'null') from public.transactions where entry_reference = 'ref-1'"]),
      'loose tag,a,b,café|null',
    );
    assert.strictEqual(psql(dbUrl(), ['-c', "select coalesce(note, 'null') from public.transactions where entry_reference = 'ref-2'"]), 'null');
    assert.strictEqual(as('authenticated', A, "select string_agg(tag, ',') from public.my_transaction_tags()"), 'a,b,café,loose tag');
  });
});
