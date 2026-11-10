const test = require('node:test');
const assert = require('node:assert');
const { applyRules, planRuleReapply, matchRule } = require('./rules');

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

test('contains (the default for older rules) matches anywhere, so "bar" hits "Barclays"', () => {
  assert.ok(matchRule(row({ creditor_name: 'BARCLAYS UK' }), rule({ match_text: 'bar' })));
  assert.ok(matchRule(row({ creditor_name: 'BARCLAYS UK' }), rule({ match_text: 'bar', match_mode: 'contains' })));
});

test('word only matches the text on its own', () => {
  const r = rule({ match_text: 'bar', match_mode: 'word' });
  assert.ok(!matchRule(row({ creditor_name: 'BARCLAYS UK' }), r));
  assert.ok(matchRule(row({ creditor_name: 'Bar Roma' }), r));
  assert.ok(matchRule(row({ creditor_name: 'PAYPAL *BAR-ROMA' }), r));
  assert.ok(!matchRule(row({ creditor_name: 'Bàrbara' }), rule({ match_text: 'bàr', match_mode: 'word' })));
  assert.ok(matchRule(row({ creditor_name: 'NETFLIX.COM' }), rule({ match_text: 'netflix.com', match_mode: 'word' })));
  assert.ok(!matchRule(row({ creditor_name: 'AXB' }), rule({ match_text: 'a.b', match_mode: 'word' })));
});

test('exact matches the whole field, ignoring case and outer spaces', () => {
  const r = rule({ match_text: ' Netflix ', match_mode: 'exact' });
  assert.ok(matchRule(row({ creditor_name: 'NETFLIX ' }), r));
  assert.ok(!matchRule(row({ creditor_name: 'NETFLIX.COM' }), r));
});

test('blank match text never matches', () => {
  assert.ok(!matchRule(row(), rule({ match_text: '   ' })));
});

test('word treats accented letters as letters, in either Unicode form', () => {
  const word = (text) => rule({ match_text: text, match_mode: 'word' });
  assert.ok(!matchRule(row({ creditor_name: 'Café Roma' }), word('caf')));
  assert.ok(!matchRule(row({ creditor_name: 'Élan Vital' }), word('lan')));
  assert.ok(matchRule(row({ creditor_name: 'Café Roma' }), word('café'))); // decomposed é
  assert.ok(!matchRule(row({ creditor_name: 'Café Roma' }), word('cafe'))); // combining mark is part of the word
});

test('word checks a boundary only on letter or digit edges', () => {
  assert.ok(matchRule(row({ creditor_name: 'AMAZON.IT' }), rule({ match_text: 'amazon.', match_mode: 'word' })));
  assert.ok(matchRule(row({ creditor_name: 'PAYPAL*NETFLIX' }), rule({ match_text: '*netflix', match_mode: 'word' })));
});

test('contains keeps the text as typed, spaces included', () => {
  assert.ok(!matchRule(row({ creditor_name: 'NETFLIX.COM' }), rule({ match_text: ' netflix' })));
});

test('reapply leaves Transfer alone, into it or out of it', () => {
  assert.deepStrictEqual(planRuleReapply([row({ category: 'Transfer' })], [rule()]), []);
  assert.deepStrictEqual(planRuleReapply([row()], [rule({ set_category: 'Transfer' })]), []);
});

// Polish pass 2 #1: building a regex per row × rule made 20k rows × 200 rules take ~9 s.
test('each rule builds its matcher once, not once per row', () => {
  const Original = RegExp;
  let built = 0;
  globalThis.RegExp = new Proxy(Original, { construct: (Target, args) => (built++, new Target(...args)) });
  try {
    const rows = Array.from({ length: 100 }, (_, i) => row({ entry_reference: `r${i}`, creditor_name: 'Lidl' }));
    const rules = [rule({ match_text: 'bar', match_mode: 'word' }), rule({ match_text: 'spotify', match_mode: 'word' })];
    planRuleReapply(rows, rules);
    applyRules(rows, rules);
  } finally {
    globalThis.RegExp = Original;
  }
  assert.ok(built <= 4, `built ${built} regexes for 2 rules`);
});
