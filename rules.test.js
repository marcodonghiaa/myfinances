const test = require('node:test');
const assert = require('node:assert');
const { applyRules, planRuleReapply } = require('./rules');

const rule = (over = {}) => ({
  user_id: 'u1',
  match_field: 'creditor_name',
  match_text: 'netflix',
  set_category: 'Entertainment',
  set_transaction_type: null,
  ...over,
});
const row = (over = {}) => ({
  user_id: 'u1',
  account_uid: 'a1',
  entry_reference: 'r1',
  creditor_name: 'NETFLIX.COM',
  remittance_info: '',
  category: 'Others',
  category_source: 'ai',
  ...over,
});

test('applyRules splits rows into matched and unmatched, first rule wins', () => {
  const rules = [rule(), rule({ set_category: 'Services' })];
  const { matched, unmatched } = applyRules([row(), row({ creditor_name: 'Lidl' })], rules);
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].rule.set_category, 'Entertainment');
  assert.strictEqual(unmatched.length, 1);
});

test('a rule never matches another user\'s row', () => {
  const { matched } = applyRules([row({ user_id: 'u2' })], [rule()]);
  assert.strictEqual(matched.length, 0);
});

test('reapply plans a category change for an AI-set row', () => {
  const items = planRuleReapply([row()], [rule()]);
  assert.deepStrictEqual(items, [
    {
      account_uid: 'a1',
      entry_reference: 'r1',
      update: { category: 'Entertainment', category_source: 'rule' },
      guardColumn: 'category_source',
      guardIn: ['ai', 'rule'],
    },
  ]);
});

test('reapply never plans a change for manual or legacy rows', () => {
  const rows = [row({ category_source: 'manual' }), row({ entry_reference: 'r2', category_source: 'legacy' })];
  assert.deepStrictEqual(planRuleReapply(rows, [rule()]), []);
});

test('reapply skips rows that already have the rule\'s category', () => {
  assert.deepStrictEqual(planRuleReapply([row({ category: 'Entertainment', category_source: 'rule' })], [rule()]), []);
});

test('reapply skips rows no rule matches', () => {
  assert.deepStrictEqual(planRuleReapply([row({ creditor_name: 'Lidl' })], [rule()]), []);
});

test('reapply ignores rules without a category', () => {
  assert.deepStrictEqual(planRuleReapply([row()], [rule({ set_category: null })]), []);
});
