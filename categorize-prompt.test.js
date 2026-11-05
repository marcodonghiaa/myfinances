const test = require('node:test');
const assert = require('node:assert');
const { buildCategorizePrompt } = require('./categorize-prompt');

const credit = {
  entry_reference: 'ref-1',
  creditor_name: null,
  debtor_name: 'Jane Example',
  remittance_info: 'games night',
  amount: 5000,
  currency: 'EUR',
  credit_debit_indicator: 'CRDT',
};

// Regression: a large incoming payment was filed as Entertainment because the payer
// (debtor_name) was fetched but never sent, so the model only saw the note.
test('the prompt sends the payer of each transaction', () => {
  assert.match(buildCategorizePrompt([credit]), /"debtor_name": "Jane Example"/);
});

test('the prompt tells the model a large incoming payment is a Transfer or Income', () => {
  const prompt = buildCategorizePrompt([credit]);
  assert.match(prompt, /CRDT/);
  assert.match(prompt, /large incoming amount[^.]*is Transfer/);
});

test('the prompt still sends the fields it sent before', () => {
  const prompt = buildCategorizePrompt([credit]);
  for (const field of ['entry_reference', 'creditor_name', 'remittance_info', 'amount', 'currency', 'direction']) {
    assert.ok(prompt.includes(`"${field}"`), field);
  }
});

test("the prompt offers the user's own list when given one", () => {
  const prompt = buildCategorizePrompt([credit], ['Groceries', 'Gym', 'Transfer']);
  assert.match(prompt, /exactly one of these categories: Groceries, Gym, Transfer\./);
  assert.doesNotMatch(prompt, /Entertainment/);
});
