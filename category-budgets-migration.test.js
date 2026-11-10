const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261202100000_category_budgets.sql');
const down = strip('supabase/rollbacks/20261202100000_category_budgets.down.sql');

test('one budget row per user, category and month, months start on the 1st', () => {
  assert.match(up, /primary key \(user_id, category, month\)/);
  assert.match(up, /month date not null check \(extract\(day from month\) = 1\)/);
});

// Splitwise categories go up to 100 characters; a budget must accept any category spend can have.
test('category names are trimmed and up to 100 characters, like Splitwise ones', () => {
  assert.match(up, /category text not null check \(category = btrim\(category\) and char_length\(category\) between 1 and 100\)/);
});

test('amounts are never negative, rollover is off unless chosen', () => {
  assert.match(up, /amount numeric\(12, 2\) not null check \(amount >= 0/);
  assert.match(up, /rollover boolean not null default false/);
});

test('each user sees and changes only their own budgets', () => {
  assert.match(up, /alter table public\.category_budgets enable row level security/);
  assert.match(up, /for all to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)\s+with check \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(up, /revoke all on public\.category_budgets from anon/);
  assert.match(up, /user_id uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/);
});

test('the rollback drops the table', () => {
  assert.match(down, /drop table if exists public\.category_budgets/);
});
