const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/migrations/20261210000001_require_mfa.sql', 'utf8').replace(/--.*$/gm, '');

test('mfa_satisfied: aal2, or no verified factor of the caller', () => {
  assert.match(code, /auth\.jwt\(\) ->> 'aal'\), 'aal1'\) = 'aal2'/);
  assert.match(code, /f\.user_id = \(select auth\.uid\(\)\) and f\.status = 'verified'/);
  assert.match(code, /security definer\s+set search_path to ''/);
});

test('anon cannot call mfa_satisfied', () => {
  assert.match(code, /revoke execute on function public\.mfa_satisfied\(\) from public, anon;/);
});

test('policy is restrictive on every RLS table, for reads and writes', () => {
  assert.match(code, /c\.relkind = 'r' and c\.relrowsecurity/);
  assert.match(code, /as restrictive for all to authenticated using \(\(select public\.mfa_satisfied\(\)\)\) with check \(\(select public\.mfa_satisfied\(\)\)\)/);
});
