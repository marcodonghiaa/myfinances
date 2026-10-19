const test = require('node:test');
const assert = require('node:assert');
const { CATEGORIES, guideFor } = require('./categories');
const { SPLITWISE_CATEGORIES } = require('./splitwise-categories');

test('Taxes is a category', () => {
  assert.ok(CATEGORIES.includes('Taxes'));
});

test('every category has a guide line, so the AI prompt never prints "undefined"', () => {
  const guide = guideFor(CATEGORIES);
  assert.ok(!guide.includes('undefined'));
  assert.strictEqual(guide.split('\n').length, CATEGORIES.length);
});

test('the Taxes guide names the tax payments to expect', () => {
  assert.match(guideFor(['Taxes']), /F24/);
});

test('shared Splitwise expenses are never taxes', () => {
  assert.ok(!SPLITWISE_CATEGORIES.includes('Taxes'));
});
