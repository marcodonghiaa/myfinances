const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/migrations/20261127000000_cursor_fk_and_consent_clock.sql', 'utf8').replace(/--.*$/gm, '');

test('orphan cursors go first, then the key cascades from accounts', () => {
  assert.ok(code.indexOf('delete from public.sync_cursors') < code.indexOf('add constraint sync_cursors_account_uid_fkey'));
  assert.match(code, /references public\.accounts \(uid\) on delete cascade not valid;/);
  assert.match(code, /validate constraint sync_cursors_account_uid_fkey;/);
});

// Otherwise a user can backdate-proof their own consent row and outlive the 15-minute window.
test('pending consents take the database clock on insert and update', () => {
  assert.match(code, /new\.created_at := now\(\);/);
  assert.match(code, /before insert or update of created_at on public\.pending_bank_consents/);
});
