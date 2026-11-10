const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261129000000_flow_only_rules.sql');
const down = strip('supabase/rollbacks/20261129000000_flow_only_rules.down.sql');

test('a rule that only sets the flow passes the action check', () => {
  assert.match(up, /drop constraint if exists at_least_one_action/);
  assert.match(up, /set_category is not null or set_transaction_type is not null or set_flow_type is not null/);
});

test('rollback removes flow-only rules before restoring the old check', () => {
  assert.ok(down.indexOf('delete from public.category_rules') < down.indexOf('add constraint'));
  assert.match(down, /check \(set_category is not null or set_transaction_type is not null\);/);
});
