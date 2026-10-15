const test = require('node:test');
const assert = require('node:assert');
const { createStallGuard } = require('./stall-guard');

const rows = (user_id, ...refs) => refs.map((r) => ({ user_id, account_uid: 'acc', entry_reference: r }));

test('a first batch is never a stall', () => {
  assert.strictEqual(createStallGuard().isStalled(rows('a', '1', '2')), false);
});

test('the same batch twice in a row is a stall and marks that user stuck', () => {
  const guard = createStallGuard();
  guard.isStalled(rows('a', '1'));
  assert.strictEqual(guard.isStalled(rows('a', '1')), true);
  assert.deepStrictEqual([...guard.stuckUserIds], ['a']);
});

test('a different batch means progress', () => {
  const guard = createStallGuard();
  guard.isStalled(rows('a', '1', '2'));
  assert.strictEqual(guard.isStalled(rows('a', '2')), false);
  assert.strictEqual(guard.stuckUserIds.size, 0);
});

test('after a stall the next user starts fresh and is not flagged', () => {
  const guard = createStallGuard();
  guard.isStalled(rows('a', '1'));
  guard.isStalled(rows('a', '1'));
  assert.strictEqual(guard.isStalled(rows('b', '1')), false);
  assert.deepStrictEqual([...guard.stuckUserIds], ['a']);
});
