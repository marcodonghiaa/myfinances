const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { checkApplication, exitCode } = require('./eb-check');

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const REJECTED =
  'Enable Banking rejected the APP_ID or the .pem key. Check that APP_ID is the application id shown next to the app, and that the .pem is the one downloaded when you registered that app.';

test('an active app is ok and named, sending the token as a Bearer header', async () => {
  const calls = [];
  const result = await checkApplication(async (url, init) => {
    calls.push({ url, init });
    return reply(200, { name: 'My Finances', kid: 'k', environment: 'PRODUCTION', active: true });
  }, 'tok123');
  assert.deepStrictEqual(result, { ok: true, message: 'Enable Banking app OK (My Finances, PRODUCTION).' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.enablebanking.com/application');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok123');
});

test('an inactive app is not ok and says how to activate it', async () => {
  const result = await checkApplication(async () => reply(200, { name: 'x', environment: 'PRODUCTION', active: false }), 't');
  assert.deepStrictEqual(result, {
    ok: false,
    retry: true,
    message:
      'Your Enable Banking app is Inactive. Activate it: https://enablebanking.com/cp/applications → your app → Activate by linking accounts (link any one of your accounts), then try again.',
  });
});

for (const status of [401, 403]) {
  test(`HTTP ${status} means a wrong APP_ID or key, without echoing the body`, async () => {
    const result = await checkApplication(
      async () => reply(status, { code: status, message: 'SECRET_BODY_TEXT', error: 'SECRET_BODY_TEXT' }),
      't',
    );
    assert.deepStrictEqual(result, { ok: false, message: REJECTED });
  });
}

test('another status does not block setup and never echoes the body', async () => {
  const result = await checkApplication(async () => reply(500, { message: 'SECRET_BODY_TEXT' }), 't');
  assert.deepStrictEqual(result, {
    ok: true,
    message: "Couldn't reach Enable Banking (HTTP 500); setup goes on, check it later.",
  });
});

test('a network error does not block setup and names only the error tag', async () => {
  const result = await checkApplication(async () => {
    throw Object.assign(new Error('SECRET_BODY_TEXT'), { code: 'ENOTFOUND' });
  }, 't');
  assert.deepStrictEqual(result, {
    ok: true,
    message: "Couldn't reach Enable Banking (ENOTFOUND); setup goes on, check it later.",
  });
});

test('main treats a key crypto cannot parse as rejected', async () => {
  const { main } = require('./eb-check');
  const result = await main({
    getToken: () => {
      throw new Error('error:1E08010C:DECODER routines::unsupported');
    },
    fetch: async () => assert.fail('must not call Enable Banking without a token'),
  });
  assert.deepStrictEqual(result, { ok: false, message: REJECTED });
});

test('exit code: 0 when ok, 1 when a retry can fix it (Inactive), 2 when the APP_ID or key is wrong', () => {
  assert.strictEqual(exitCode({ ok: true }), 0);
  assert.strictEqual(exitCode({ ok: false, retry: true }), 1);
  assert.strictEqual(exitCode({ ok: false }), 2);
});

test('the CLI exits 2 on a key crypto cannot parse, before any network call', () => {
  let status = 0;
  try {
    execFileSync(process.execPath, ['eb-check.js'], {
      cwd: __dirname,
      env: { ...process.env, APP_ID: 'x', PRIVATE_KEY: 'garbage' },
      stdio: 'pipe',
    });
  } catch (err) {
    status = err.status;
  }
  assert.strictEqual(status, 2);
});
