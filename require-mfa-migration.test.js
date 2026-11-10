const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (f) => fs.readFileSync(f, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261203000000_require_mfa.sql');
const down = strip('supabase/rollbacks/20261203000000_require_mfa.down.sql');

test('mfa_satisfied: aal2, or no verified factor of the caller', () => {
  assert.match(up, /auth\.jwt\(\) ->> 'aal'\), 'aal1'\) = 'aal2'/);
  assert.match(up, /f\.user_id = \(select auth\.uid\(\)\) and f\.status = 'verified'/);
  assert.match(up, /revoke execute on function public\.mfa_satisfied\(\) from public, anon;/);
});

test('every Data API request goes through require_mfa, which every API role can run', () => {
  assert.match(up, /if not public\.mfa_satisfied\(\) then\s+raise exception/);
  assert.match(up, /grant execute on function public\.require_mfa\(\) to anon, authenticated, service_role;/);
  assert.match(up, /alter role authenticator set pgrst\.db_pre_request to 'public\.require_mfa';\s+notify pgrst, 'reload config';/);
});

test('refuses to replace another pre-request hook', () => {
  assert.match(up, /existing is not null and existing <> 'public\.require_mfa' then\s+raise exception/);
});

test('rollback removes the hook before dropping the functions', () => {
  assert.match(down, /alter role authenticator reset pgrst\.db_pre_request;\s+notify pgrst, 'reload config';\s+drop function if exists public\.require_mfa\(\);\s+drop function if exists public\.mfa_satisfied\(\);/);
});
