const test = require('node:test');
const assert = require('node:assert');
const { applyLearned, fetchLearned, learnedUpdate } = require('./learned-categories');

// Regression: a merchant you had set to Housing by hand, again and again, came back as Shopping
// on its next transaction, because the AI never saw your choices.
test('a new row takes the category you last set by hand for the same merchant', () => {
  const learned = new Map([['FOUND STUDY SOUTHSIDE', 'Housing']]);
  const rows = [
    { entry_reference: 'r1', creditor_name: 'FOUND STUDY SOUTHSIDE' },
    { entry_reference: 'r2', creditor_name: 'NEW SHOP' },
    { entry_reference: 'r3', creditor_name: null },
  ];
  const { matched, unmatched } = applyLearned(rows, learned);
  assert.deepStrictEqual(matched.map((m) => [m.row.entry_reference, m.category]), [['r1', 'Housing']]);
  assert.deepStrictEqual(unmatched.map((r) => r.entry_reference), ['r2', 'r3']);
});

test('Transfer learned from you also takes the row out of spending', () => {
  assert.deepStrictEqual(learnedUpdate('Transfer'), { category: 'Transfer', category_source: 'rule' });
  assert.deepStrictEqual(learnedUpdate('Housing'), { category: 'Housing', category_source: 'rule' });
});

test('fetchLearned keeps the most recent hand-set category per merchant, for that user only', async () => {
  const calls = {};
  const q = {
    select: () => q,
    eq: (c, v) => ((calls[c] = v), q),
    in: (c, v) => ((calls[c] = v), q),
    not: () => q,
    is: () => q,
    order: () => q,
    range: async () => ({
      data: [
        { creditor_name: 'A', category: 'Housing', booking_date: '2026-10-01' },
        { creditor_name: 'A', category: 'Shopping', booking_date: '2026-09-01' },
      ],
      error: null,
    }),
  };
  const learned = await fetchLearned({ from: () => q }, 'u1', ['A', 'A', null]);
  assert.strictEqual(learned.get('A'), 'Housing');
  assert.strictEqual(calls.user_id, 'u1');
  assert.strictEqual(calls.category_source, 'manual');
  assert.deepStrictEqual(calls.creditor_name, ['A']);
});

test('an AI row is corrected to your category; your own and rule rows never are', () => {
  const { planRelearn } = require('./learned-categories');
  const learned = new Map([['FOUND STUDY', 'Housing']]);
  const plan = planRelearn(
    [
      { entry_reference: 'ai-wrong', creditor_name: 'FOUND STUDY', category: 'Shopping', category_source: 'ai' },
      { entry_reference: 'ai-right', creditor_name: 'FOUND STUDY', category: 'Housing', category_source: 'ai' },
      { entry_reference: 'mine', creditor_name: 'FOUND STUDY', category: 'Shopping', category_source: 'manual' },
      { entry_reference: 'other', creditor_name: 'OTHER', category: 'Shopping', category_source: 'ai' },
    ],
    learned,
  );
  assert.deepStrictEqual(plan.map((p) => [p.row.entry_reference, p.category]), [['ai-wrong', 'Housing']]);
});
