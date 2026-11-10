const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261202000000_rule_match_mode.sql');
const down = strip('supabase/rollbacks/20261202000000_rule_match_mode.down.sql');

test('existing rules keep substring matching; only the three modes are allowed', () => {
  assert.match(up, /add column if not exists match_mode text not null default 'contains'/);
  assert.match(up, /check \(match_mode in \('contains', 'word', 'exact'\)\)/);
});

test('rollback drops the check before the column', () => {
  assert.ok(down.indexOf('drop constraint') < down.indexOf('drop column if exists match_mode'));
});
