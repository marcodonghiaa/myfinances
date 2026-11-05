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

const { categoriesFor } = require('./categories');

// A self-hoster wanted their own categories instead of the built-in ones.
test("a user's list drops the built-ins they hid and adds their own", () => {
  const list = categoriesFor([
    { name: 'Taxes', hidden: true },
    { name: 'Experiences', hidden: true },
    { name: 'Gym', hidden: false },
    { name: 'Gifts', hidden: false },
  ]);
  assert.ok(!list.includes('Taxes') && !list.includes('Experiences'));
  assert.deepStrictEqual(list.slice(-2), ['Gym', 'Gifts']);
  assert.ok(list.includes('Transfer') && list.includes('Income'));
});

test('with no rows the list is the built-in one', () => {
  assert.deepStrictEqual(categoriesFor([]), CATEGORIES);
});

test('the prompt guide describes a category the user created', () => {
  assert.match(guideFor(['Gym']), /- Gym: a category the user created/);
});
