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

// polish-5 #2: a hook of the user's own that calls require_mfa() would error on every request once
// the rollback drops it, and an unrelated hook of theirs must not be reset by the rollback.
test('rollback stops while another hook still calls require_mfa, and resets only its own hook', () => {
  const down = fs.readFileSync(path.join(__dirname, 'supabase/rollbacks/20261203000000_require_mfa.down.sql'), 'utf8');
  assert.match(down, /prosrc ilike '%require_mfa%'/);
  assert.match(down, /raise exception/);
  assert.doesNotMatch(down, /^alter role authenticator reset pgrst\.db_pre_request;/m, 'unconditional reset');
  assert.match(down, /in database %I reset pgrst\.db_pre_request/);
});

// polish-5 #6: run outside a transaction, a refused migration must not leave its functions behind.
test('migration refuses an existing hook before it creates anything', () => {
  const up = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261203000000_require_mfa.sql'), 'utf8');
  const refuse = up.indexOf('PostgREST already runs pre-request hook');
  assert.ok(refuse >= 0 && refuse < up.indexOf('create or replace function'), 'check comes after a create');
});

// polish-5 #2 re-audit: plain `psql -f` keeps going after the refusal and drops the function anyway.
test('UPGRADING says to run the rollback so a refusal stops it', () => {
  const doc = fs.readFileSync(path.join(__dirname, 'UPGRADING.md'), 'utf8');
  assert.match(doc, /remove its `require_mfa\(\)` call first[^\n]*ON_ERROR_STOP=1 -1/);
});
