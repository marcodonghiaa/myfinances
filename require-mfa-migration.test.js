const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The database refuses aal1 sessions on the Data API, but Edge Functions that act with the service
// role skip that, so every function that reads the caller's JWT must also ask the database.
test('every Edge Function that signs the caller in also checks two-step sign-in', () => {
  const dir = path.join(__dirname, 'supabase/functions');
  const missing = fs.readdirSync(dir)
    .filter((f) => !f.startsWith('_') && fs.existsSync(path.join(dir, f, 'index.ts')))
    .filter((f) => {
      const src = fs.readFileSync(path.join(dir, f, 'index.ts'), 'utf8');
      return src.includes('auth.getUser(') && !src.includes('await mfaRefusal(');
    });
  assert.deepStrictEqual(missing, []);
});

test('rollback removes the hook before dropping the functions it calls', () => {
  const down = fs.readFileSync(path.join(__dirname, 'supabase/rollbacks/20261203000000_require_mfa.down.sql'), 'utf8');
  const order = ['reset pgrst.db_pre_request', 'drop function if exists public.require_mfa', 'drop function if exists public.mfa_satisfied']
    .map((s) => down.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), 'wrong order or missing step');
});

// polish-5 #1: a hook set per database survives a role-wide reset, so the push would fail again.
test('UPGRADING says how to clear an existing hook set per database too', () => {
  const doc = fs.readFileSync(path.join(__dirname, 'UPGRADING.md'), 'utf8');
  assert.match(doc, /alter role authenticator in database postgres reset pgrst\.db_pre_request;/);
});
