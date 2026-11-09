const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/migrations/20261125000000_account_deletion.sql', 'utf8').replace(/--.*$/gm, '');
const down = fs.readFileSync('supabase/rollbacks/20261125000000_account_deletion.down.sql', 'utf8').replace(/--.*$/gm, '');

// Without cascades Postgres refuses to delete a user who still has rows.
test('keys to users and accounts with no delete rule start cascading', () => {
  assert.match(code, /c\.confdeltype = 'a'/);
  assert.match(code, /'auth\.users'::regclass, 'public\.accounts'::regclass,\s+'public\.portfolio_holdings'::regclass, 'public\.crypto_holdings'::regclass/);
  assert.match(code, /on delete cascade/);
});

// Session ids let anyone holding the app key read the user's bank data: never reachable from the browser.
test('bank_sessions is server-only', () => {
  assert.match(code, /alter table public\.bank_sessions enable row level security;/);
  assert.doesNotMatch(code, /create policy/i);
  assert.match(code, /revoke all on table public\.bank_sessions from anon, authenticated;/);
});

test('rollback keeps the keys that cascaded before', () => {
  assert.match(down, /drop table if exists public\.bank_sessions;/);
  assert.match(down, /'merchant_aliases', 'holding_trades',\s+'user_categories', 'recurring_streams'/);
});

// Otherwise the next-oldest user silently becomes owner and may add dashboard addresses.
test('the owner cannot delete themselves while other users remain; only the server may ask', () => {
  assert.match(code, /p_user is distinct from \(select id from auth\.users order by created_at, id limit 1\)/);
  assert.match(code, /or not exists \(select 1 from auth\.users where id <> p_user\)/);
  assert.match(code, /revoke execute on function public\.can_delete_user\(uuid\) from public, anon, authenticated;/);
});
