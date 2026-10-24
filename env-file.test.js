const test = require('node:test');
const assert = require('node:assert');
const { mergeEnv, parseEnv } = require('./env-file');

test('mergeEnv replaces values, keeps comments and keys it does not know, appends new keys', () => {
  const before = '# Enable Banking\nAPP_ID=old\nCOINBASE_API_KEY_NAME=mine\n\nGEMINI_MODEL=custom\n';
  const after = mergeEnv(before, { APP_ID: 'new', USER_ID: 'u1' });
  assert.strictEqual(after, '# Enable Banking\nAPP_ID=new\nCOINBASE_API_KEY_NAME=mine\n\nGEMINI_MODEL=custom\nUSER_ID=u1\n');
});

test('mergeEnv writes values with = and escaped newlines unchanged', () => {
  const after = mergeEnv('', { PRIVATE_KEY: '-----BEGIN-----\\nab==\\n-----END-----' });
  assert.strictEqual(after, 'PRIVATE_KEY=-----BEGIN-----\\nab==\\n-----END-----\n');
});

test('mergeEnv leaves a commented-out key alone and adds the real one', () => {
  assert.strictEqual(mergeEnv('# FRONTEND_DIR=../x\n', { FRONTEND_DIR: '../y' }), '# FRONTEND_DIR=../x\nFRONTEND_DIR=../y\n');
});

test('parseEnv reads plain and quoted values and skips comments', () => {
  assert.deepStrictEqual(parseEnv('# x=1\nA=1\nB="two words"\nC=a=b\n'), { A: '1', B: 'two words', C: 'a=b' });
});
