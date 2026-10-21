const test = require('node:test');
const assert = require('node:assert');
const { ensureUser } = require('./first-user');

const args = { url: 'https://x.supabase.co', secretKey: 'sb_secret_k', email: 'Me@Example.com', password: 'pw123456' };
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('creates the user with a confirmed email and returns its id', async () => {
  const calls = [];
  const id = await ensureUser(args, async (url, init) => {
    calls.push({ url, init });
    return reply(200, { id: 'u1' });
  });
  assert.strictEqual(id, 'u1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://x.supabase.co/auth/v1/admin/users');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { email: 'Me@Example.com', password: 'pw123456', email_confirm: true });
  assert.strictEqual(calls[0].init.headers.apikey, 'sb_secret_k');
});

test('an email that already exists returns the existing id, matching case-insensitively', async () => {
  const id = await ensureUser(args, async (url) =>
    url.includes('per_page')
      ? reply(200, { users: [{ id: 'other', email: 'x@y.z' }, { id: 'u2', email: 'me@example.com' }] })
      : reply(422, { error_code: 'email_exists', msg: 'already registered' }),
  );
  assert.strictEqual(id, 'u2');
});

test('any other creation failure throws with the status and reason, and never lists users', async () => {
  let calls = 0;
  await assert.rejects(
    ensureUser(args, async () => {
      calls += 1;
      return reply(422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
    }),
    /HTTP 422.*at least 6 characters/,
  );
  assert.strictEqual(calls, 1);
});

test('throws when the existing user cannot be found or listed', async () => {
  const exists = reply(422, { error_code: 'email_exists' });
  await assert.rejects(
    ensureUser(args, async (url) => (url.includes('per_page') ? reply(200, { users: [] }) : exists)),
    /not found in the user list/,
  );
  await assert.rejects(
    ensureUser(args, async (url) => (url.includes('per_page') ? reply(500, {}) : exists)),
    /Could not list users.*500/,
  );
});

test('a non-JSON error body still gives a readable error', async () => {
  await assert.rejects(
    ensureUser(args, async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } })),
    /HTTP 502.*unknown error/,
  );
});
