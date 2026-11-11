// Two-user proof that category_budgets keeps each user's budgets private, run against a real
// Postgres. Needs psql and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server, e.g.
// postgres://postgres@localhost:5432/postgres); skipped without it. A fresh database is created
// and dropped for each run.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const db = `budgets_rls_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
// Runs sql as `role` (with user `sub` signed in, if given) inside a rolled-back transaction.
// Returns the output, or the error message when Postgres refuses.
function as(role, sub, sql) {
  const claims = sub ? `set local request.jwt.claims = '{"sub":"${sub}"}';` : '';
  try {
    return psql(dbUrl(), ['-c', `begin; set local role ${role}; ${claims} ${sql}; rollback;`]);
  } catch (e) {
    return `ERROR ${String(e.stderr)}`;
  }
}

test('category_budgets RLS with two users', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql']);
  psql(dbUrl(), ['-f', 'supabase/migrations/20261202100000_category_budgets.sql']);
  psql(dbUrl(), [
    '-c',
    `insert into auth.users values ('${A}'), ('${B}');
     insert into public.category_budgets (user_id, category, month, amount) values
       ('${A}', 'Groceries', '2026-11-01', 300), ('${B}', 'Rent', '2026-11-01', 900);`,
  ]);

  await t.test('a user reads only their own budgets', () => {
    assert.strictEqual(as('authenticated', B, 'select string_agg(category, \',\') from public.category_budgets'), 'Rent');
    assert.strictEqual(as('authenticated', B, `select count(*) from public.category_budgets where user_id = '${A}'`), '0');
  });

  await t.test("a user can't change or delete another user's budgets", () => {
    assert.match(as('authenticated', B, `update public.category_budgets set amount = 1 where user_id = '${A}' returning 1`), /^$/);
    assert.match(as('authenticated', B, `delete from public.category_budgets where user_id = '${A}' returning 1`), /^$/);
  });

  await t.test("a user can't write rows for another user", () => {
    const insert = `insert into public.category_budgets (user_id, category, month, amount) values ('${A}', 'Groceries', '2026-11-01', 5)`;
    assert.match(as('authenticated', B, insert), /row-level security/);
    assert.match(as('authenticated', B, `${insert} on conflict (user_id, category, month) do update set amount = 5`), /row-level security/);
    assert.match(as('authenticated', B, `update public.category_budgets set user_id = '${A}'`), /row-level security/);
  });

  await t.test('a signed-in user saves budgets for themselves', () => {
    assert.strictEqual(
      as('authenticated', B, `insert into public.category_budgets (category, month, amount) values ('Gym', '2026-11-01', 40) returning user_id`),
      B,
    );
  });

  // TRUNCATE skips RLS: with it one user could empty every user's budgets.
  await t.test("a signed-in user can't empty the whole table", () => {
    assert.match(as('authenticated', B, 'truncate public.category_budgets'), /permission denied/);
  });

  // A month range keeps one account from filling the database with far-off months.
  await t.test('budgets only for months from 2000 to 2100', () => {
    const add = (month) =>
      as('authenticated', B, `insert into public.category_budgets (category, month, amount) values ('Gym', '${month}', 40) returning 1`);
    assert.strictEqual(add('2000-01-01'), '1');
    assert.strictEqual(add('2100-12-01'), '1');
    assert.match(add('1999-12-01'), /check constraint/);
    assert.match(add('2101-01-01'), /check constraint/);
  });

  // P5 P2-18: a tab or line break around a name would make a second, look-alike category.
  await t.test('category names have no spaces, tabs or line breaks around them', () => {
    const add = (category) =>
      as('authenticated', B, `insert into public.category_budgets (category, month, amount) values (${category}, '2026-11-01', 40) returning 1`);
    assert.strictEqual(add("'Eating out'"), '1');
    assert.match(add("' Gym'"), /check constraint/);
    assert.match(add("E'Gym\\n'"), /check constraint/);
    assert.match(add("E'\\tGym'"), /check constraint/);
    assert.match(add("E'Gym\\r'"), /check constraint/);
  });

  await t.test('signed-out visitors get nothing', () => {
    assert.match(as('anon', null, 'select count(*) from public.category_budgets'), /permission denied/);
    assert.strictEqual(as('authenticated', null, 'select count(*) from public.category_budgets'), '0');
  });

  await t.test("deleting a user deletes their budgets", () => {
    assert.strictEqual(
      psql(dbUrl(), ['-c', `begin; delete from auth.users where id = '${A}'; select count(*) from public.category_budgets where user_id = '${A}'; rollback;`]),
      '0',
    );
  });
});
