const test = require('node:test');
const assert = require('node:assert');
const { errorTag } = require('./log-safe');

test('errorTag never returns message or details', () => {
  const pg = { code: '23505', message: 'duplicate key', details: 'Key (iban)=(IT60X0542811101000000123456) already exists.' };
  assert.strictEqual(errorTag(pg), '23505');
  assert.strictEqual(errorTag(Object.assign(new Error('API error 401: {"name":"Marco"}'), { status: 401 })), 'HTTP 401');
  assert.strictEqual(errorTag(new TypeError('fetch failed for Marco')), 'TypeError');
  assert.strictEqual(errorTag('boom'), 'Error');
  assert.strictEqual(errorTag(null), 'Error');
});
