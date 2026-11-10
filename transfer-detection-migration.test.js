const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const code = fs.readFileSync('supabase/migrations/20261128000000_transfer_detection.sql', 'utf8').replace(/--.*$/gm, '');
const down = fs.readFileSync('supabase/rollbacks/20261128000000_transfer_detection.down.sql', 'utf8').replace(/--.*$/gm, '');

// What the user decided never changes by itself: history is frozen as theirs before anything runs.
test('every existing flow is backfilled as legacy before the trigger exists', () => {
  assert.match(code, /update public\.transactions set flow_source = 'legacy' where flow_type is not null/);
  assert.ok(code.indexOf("set flow_source = 'legacy'") < code.indexOf('create trigger trg_flow_source_user'));
});

// A user can't pick 'default' to reopen automation, nor fake own_counterparty.
test('a signed-in user\'s flow or flow_source change is always theirs; own_counterparty is bank-only', () => {
  assert.match(code, /when \(auth\.role\(\) = 'authenticated'::text\)/);
  assert.match(code, /before insert or update of flow_type, flow_source on public\.transactions/);
  assert.match(code, /or new\.flow_source is distinct from old\.flow_source then/);
  assert.match(code, /or new\.own_counterparty is distinct from old\.own_counterparty/);
  assert.doesNotMatch(down, /own_counterparty is distinct/);
  assert.match(down, /create or replace function public\.restrict_transaction_updates\(\)/);
});

test('flow_source and set_flow_type only take known values', () => {
  assert.match(code, /flow_source in \('user', 'legacy', 'rule', 'own_account', 'pair', 'bank', 'default'\)/);
  assert.match(code, /set_flow_type in \('spend', 'income', 'transfer'\)/);
});

test('transfer pairs: cascade with the user and the rows, one live pair per side, read-only to users', () => {
  assert.match(code, /user_id uuid not null references auth\.users \(id\) on delete cascade/);
  assert.equal((code.match(/references public\.transactions \(account_uid, entry_reference\) on delete cascade/g) || []).length, 2);
  assert.match(code, /unique index transfer_pairs_out_key .* where status <> 'rejected'/);
  assert.match(code, /unique index transfer_pairs_in_key .* where status <> 'rejected'/);
  assert.match(code, /alter table public\.transfer_pairs enable row level security/);
  assert.match(code, /revoke all on table public\.transfer_pairs from anon, authenticated/);
  assert.match(code, /grant select on table public\.transfer_pairs to authenticated/);
  assert.doesNotMatch(code, /grant (insert|update|delete|all)[^;]*transfer_pairs/);
});

test('resolve_transfer_pair checks the caller owns the pair and runs with an empty search_path', () => {
  const fn = code.slice(code.indexOf('create function public.resolve_transfer_pair'));
  assert.match(fn, /security definer\s+set search_path to ''/);
  assert.match(fn, /where id = p_pair and user_id = auth\.uid\(\)/);
  assert.match(fn, /if p_keep is null then/);
  assert.match(fn, /if v_pair\.status <> 'suggested' then/);
  // Stale: only rows still as pairing left them, not deleted, and both of them.
  assert.match(fn, /and t\.flow_source in \('pair', 'bank'\)\s+and t\.deleted_at is null/);
  assert.match(fn, /if v_rows <> 2 then/);
  assert.match(fn, /revoke execute on function public\.resolve_transfer_pair\(uuid, boolean\) from public, anon;/);
  assert.match(fn, /grant execute on function public\.resolve_transfer_pair\(uuid, boolean\) to authenticated;/);
});

test('the rollback drops everything the migration adds', () => {
  for (const what of [/drop function if exists public\.resolve_transfer_pair\(uuid, boolean\)/, /drop table if exists public\.transfer_pairs/,
    /drop trigger if exists trg_flow_source_user/, /drop function if exists public\.flow_source_user\(\)/,
    /drop column if exists set_flow_type/, /drop column if exists own_counterparty/, /drop column if exists flow_source/]) {
    assert.match(down, what);
  }
});
