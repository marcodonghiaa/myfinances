const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, planUpdates, SPLITWISE_CATEGORIES } = require('./splitwise-categories');

const rows = [
  { id: 'id-1', user_id: 'u1', description: 'Oil + toilet paper', amount: 4.13, currency: 'USD', group_name: 'berkeley' },
  { id: 'id-2', user_id: 'u1', description: 'marchino', amount: 10.02, currency: 'USD', group_name: 'berkeley' },
];

test('prompt carries only id and description, never amounts, group or user', () => {
  const prompt = buildPrompt(rows);
  assert.ok(prompt.includes('Oil + toilet paper') && prompt.includes('id-1'));
  for (const secret of ['4.13', '10.02', 'berkeley', 'u1', 'USD']) assert.ok(!prompt.includes(secret), secret);
});

test('prompt marks the descriptions as untrusted', () => {
  assert.match(buildPrompt(rows), /untrusted/i);
});

test('shares are spending: Income and Transfer are not offered', () => {
  assert.ok(!SPLITWISE_CATEGORIES.includes('Income'));
  assert.ok(!SPLITWISE_CATEGORIES.includes('Transfer'));
  assert.ok(SPLITWISE_CATEGORIES.includes('Housing') && SPLITWISE_CATEGORIES.includes('Others'));
  assert.ok(!buildPrompt(rows).includes('Income:'));
});

test('keeps valid answers for rows we sent', () => {
  const plan = planUpdates([{ entry_reference: 'id-1', category: 'Housing' }], rows);
  assert.deepStrictEqual(plan, [{ id: 'id-1', user_id: 'u1', category: 'Housing' }]);
});

test('drops invalid categories and ids we never sent', () => {
  const plan = planUpdates(
    [
      { entry_reference: 'id-1', category: 'Pirates' },
      { entry_reference: 'id-1', category: 'Income' },
      { entry_reference: 'zzz', category: 'Housing' },
      { entry_reference: 'id-2', category: 'Others' },
    ],
    rows,
  );
  assert.deepStrictEqual(plan, [{ id: 'id-2', user_id: 'u1', category: 'Others' }]);
});

test('first answer wins when the model repeats an id', () => {
  const plan = planUpdates(
    [{ entry_reference: 'id-1', category: 'Housing' }, { entry_reference: 'id-1', category: 'Groceries' }],
    rows,
  );
  assert.deepStrictEqual(plan, [{ id: 'id-1', user_id: 'u1', category: 'Housing' }]);
});
