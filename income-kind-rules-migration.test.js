const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261210000000_income_kind_rules.sql');
const down = strip('supabase/rollbacks/20261210000000_income_kind_rules.down.sql');

test('a rule can mark income regular or one-off, nothing else', () => {
  assert.match(up, /add column if not exists set_income_kind text check \(set_income_kind in \('regular', 'one_off'\)\)/);
});

test('a rule that only marks income passes the action check', () => {
  assert.match(up, /drop constraint if exists at_least_one_action/);
  assert.match(up, /or set_flow_type is not null\s+or set_income_kind is not null\)/);
});

test('rollback removes income-only rules before restoring the old check and dropping the column', () => {
  const del = down.indexOf('delete from public.category_rules');
  assert.ok(del >= 0 && del < down.indexOf('add constraint'));
  assert.ok(down.indexOf('add constraint') < down.indexOf('drop column if exists set_income_kind'));
  assert.match(down, /check \(set_category is not null or set_transaction_type is not null or set_flow_type is not null\);/);
});

// Polish #4: the dashboard selects set_income_kind on every rules read; rolling the database back
// under it breaks the Rules page, Income and the calendar.
test('UPGRADING says to revert the dashboard before rolling back', () => {
  const notes = fs.readFileSync('UPGRADING.md', 'utf8');
  const entry = notes.slice(notes.indexOf('### Recurring calendar and regular income'));
  const rollback = entry.slice(entry.indexOf('**Roll back:**'), entry.indexOf('\n###'));
  assert.match(rollback, /revert the dashboard first/i);
  assert.match(rollback, /20261210000000_income_kind_rules\.down\.sql/);
  // Polish 5 E: without the repair, a later `db push` thinks the migration is still applied and
  // never brings the column back.
  assert.match(rollback, /supabase migration repair --status reverted 20261210000000/);
});
