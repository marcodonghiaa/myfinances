const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261202100000_category_budgets.sql');
const down = strip('supabase/rollbacks/20261202100000_category_budgets.down.sql');

test('one budget row per user, category and month, months start on the 1st', () => {
  assert.match(up, /primary key \(user_id, category, month\)/);
  assert.match(up, /month date not null check \(extract\(day from month\) = 1 and month between '2000-01-01' and '2100-12-01'\)/);
});

// Splitwise categories go up to 100 characters; a budget must accept any category spend can have.
test('category names are trimmed and up to 100 characters, like Splitwise ones', () => {
  assert.match(up, /category text not null check \(category = btrim\(category, E' \\t\\n\\r'\) and char_length\(category\) between 1 and 100\)/);
});

test('amounts are never negative, rollover is off unless chosen', () => {
  assert.match(up, /amount numeric\(12, 2\) not null check \(amount >= 0/);
  assert.match(up, /rollover boolean not null default false/);
});

test('each user sees and changes only their own budgets', () => {
  assert.match(up, /alter table public\.category_budgets enable row level security/);
  assert.match(up, /for all to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)\s+with check \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(up, /revoke all on public\.category_budgets from anon, authenticated;/);
  assert.match(up, /user_id uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/);
});

test('the rollback drops the table', () => {
  assert.match(down, /drop table if exists public\.category_budgets/);
});

// P5 P1-4: this release's dashboard exports category_budgets, and the export fails on a missing
// table, so the rollback note must tell people to revert the dashboard before dropping it.
test('the upgrade note says to revert the dashboard before rolling back', () => {
  const notes = fs.readFileSync('UPGRADING.md', 'utf8');
  const entry = notes.slice(notes.indexOf('### Monthly budgets per category')).split('\n### ')[0];
  assert.match(entry, /\*\*Roll back:\*\* revert the dashboard first, then `supabase\/rollbacks\/20261202100000_category_budgets\.down\.sql`/);
});

// P5 P2-16: `supabase db push` skips a migration it has on record, so after a manual rollback the
// record has to be marked reverted or the table never comes back.
test('the upgrade notes say how to run a rollback and how to re-apply it later', () => {
  const intro = fs.readFileSync('UPGRADING.md', 'utf8').split('## Release notes')[0];
  assert.match(intro, /supabase\/rollbacks\//);
  assert.match(intro, /supabase migration repair --status reverted <version> --linked/);
});

// P5 P2-17: the two-user RLS test is skipped without a database, so CI has to give it one.
test('CI runs the two-user RLS test against a real Postgres', () => {
  const ci = fs.readFileSync('.github/workflows/test.yml', 'utf8');
  assert.match(ci, /services:\s+postgres:\s+image: postgres:17/);
  assert.match(ci, /RLS_TEST_DATABASE_URL: postgres:\/\/postgres:postgres@localhost:5432\/postgres/);
});
