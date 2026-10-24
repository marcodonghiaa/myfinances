const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { checkEnv } = require('./env-check');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const complete = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_abc',
  APP_ID: 'app-id',
  PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), // stored on one line in .env
  USER_ID: '00000000-0000-0000-0000-000000000000',
  GEMINI_API_KEY: 'g',
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
};
const noFiles = () => null;

test('a complete .env has no errors or warnings', () => {
  assert.deepStrictEqual(checkEnv(complete, noFiles), { errors: [], warnings: [] });
});

test('missing required values are each named', () => {
  const { errors } = checkEnv({}, noFiles);
  for (const name of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'APP_ID', 'PRIVATE_KEY', 'USER_ID']) {
    assert.ok(errors.some((e) => e.includes(name)), `no error mentions ${name}`);
  }
});

test('the publishable key pasted as the secret key is caught', () => {
  const { errors } = checkEnv({ ...complete, SUPABASE_SECRET_KEY: 'sb_publishable_abc' }, noFiles);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /publishable/);
});

test('a Supabase URL without https is caught', () => {
  const { errors } = checkEnv({ ...complete, SUPABASE_URL: 'abcdefghijklmnopqrst.supabase.co' }, noFiles);
  assert.strictEqual(errors.length, 1);
});

test('a private key that is not a valid PEM is caught', () => {
  const { errors } = checkEnv({ ...complete, PRIVATE_KEY: 'not a key' }, noFiles);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /PRIVATE_KEY/);
});

test('PRIVATE_KEY_FILE is read when PRIVATE_KEY is empty, and a missing file is caught', () => {
  const env = { ...complete, PRIVATE_KEY: '', PRIVATE_KEY_FILE: '/keys/app.pem' };
  assert.deepStrictEqual(checkEnv(env, (p) => (p === '/keys/app.pem' ? PEM : null)).errors, []);
  assert.strictEqual(checkEnv(env, noFiles).errors.length, 1);
});

test('optional features only warn', () => {
  const env = { ...complete, GEMINI_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', COINBASE_API_KEY_NAME: 'k' };
  const { errors, warnings } = checkEnv(env, noFiles);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(warnings.length, 3); // Gemini, VAPID, half-set Coinbase
});
