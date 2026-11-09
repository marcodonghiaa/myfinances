const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

// The handler has no runtime test (Deno.serve at import); its order of steps is what matters.
const src = fs.readFileSync('supabase/functions/delete-account/index.ts', 'utf8');
const at = (s) => {
  const i = src.indexOf(s);
  assert.notStrictEqual(i, -1, `missing: ${s}`);
  return i;
};

test('password checked, then owner guard, then delete, then bank sessions closed', () => {
  assert.ok(at('signInWithPassword(') < at('rpc("can_delete_user"'));
  assert.ok(at('rpc("can_delete_user"') < at('auth.admin.deleteUser('));
  // Closing first would leave a user whose delete failed with disconnected banks.
  assert.ok(at('auth.admin.deleteUser(') < at('await closeSessions('));
});

test('a wrong password or another user is refused', () => {
  assert.match(src, /if \(passwordError \|\| signedIn\.user\?\.id !== userId\) \{\s+return json\(\{ error: "Wrong password" \}, 403\);/);
});
