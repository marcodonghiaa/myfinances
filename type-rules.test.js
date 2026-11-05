const test = require('node:test');
const assert = require('node:assert');
const { applyRules } = require('./rules');

// Regression: a rule that sets only a type ("spotify -> Subscription") was saved and listed but
// never applied. classify-type.js now runs those rules through the same matcher before the AI.
test('a type-only rule matches its own user\'s rows', () => {
  const rules = [{ user_id: 'u1', match_field: 'any', match_text: 'spotify', set_category: null, set_transaction_type: 'Subscription' }];
  const rows = [
    { user_id: 'u1', creditor_name: 'SPOTIFY AB', remittance_info: '' },
    { user_id: 'u2', creditor_name: 'SPOTIFY AB', remittance_info: '' },
    { user_id: 'u1', creditor_name: 'Coop', remittance_info: '' },
  ];
  const { matched, unmatched } = applyRules(rows, rules);
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].rule.set_transaction_type, 'Subscription');
  assert.strictEqual(unmatched.length, 2);
});
