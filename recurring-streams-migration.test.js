const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = read('supabase/migrations/20261120000000_recurring_streams.sql');
const down = read('supabase/rollbacks/20261120000000_recurring_streams.down.sql');
const fnBody = (name) => {
  const i = up.indexOf(`function public.${name}(`);
  return up.slice(i, up.indexOf('$$;', up.indexOf('$$', i) + 2) + 3);
};

test('table is unique per stream, RLS on, select-only for users', () => {
  assert.match(up, /create table public\.recurring_streams/);
  assert.match(up, /unique \(user_id, stream_key\)/);
  assert.match(up, /alter table public\.recurring_streams enable row level security/);
  assert.match(up, /create policy "[^"]+" on public\.recurring_streams\s+for select to authenticated/);
  assert.doesNotMatch(up, /create policy[^;]*on public\.recurring_streams\s+for (insert|update|delete|all)/);
  assert.match(up, /revoke insert, update, delete, truncate on public\.recurring_streams from anon, authenticated/);
  assert.doesNotMatch(up, /grant (insert|update|delete|all)[^;]*recurring_streams/);
});

test('upsert_detected_streams is service-role only and never writes user columns', () => {
  const fn = fnBody('upsert_detected_streams');
  assert.match(fn, /security definer set search_path = public/);
  assert.match(up, /revoke execute on function public\.upsert_detected_streams\(uuid, jsonb\) from public, anon, authenticated/);
  assert.match(up, /grant execute on function public\.upsert_detected_streams\(uuid, jsonb\) to service_role/);
  assert.doesNotMatch(up, /grant execute on function public\.upsert_detected_streams[^;]* to (public|anon|authenticated)/);
  const set = fn.slice(fn.indexOf('do update set'));
  assert.doesNotMatch(set, /user_status|user_cadence|custom_interval|source/);
  assert.doesNotMatch(fn, /\bdelete\b/i);
});

test('stream_action checks ownership, raises on unknown action, authenticated only', () => {
  const fn = fnBody('stream_action');
  assert.match(fn, /security definer set search_path = public/);
  assert.match(fn, /user_id = auth\.uid\(\)/);
  assert.match(fn, /raise exception 'Unknown stream action/);
  for (const a of ['confirm', 'dismiss', 'undismiss', 'set_cadence']) assert.match(fn, new RegExp(`p_action = '${a}'`));
  assert.match(fn, /updated_at = now\(\)/);
  assert.match(up, /revoke execute on function public\.stream_action\(uuid, text, jsonb\) from public, anon/);
  assert.match(up, /grant execute on function public\.stream_action\(uuid, text, jsonb\) to authenticated/);
});

test('override migration is idempotent and keeps dismissals', () => {
  const m = up.slice(up.indexOf('from public.subscription_billing_overrides'));
  assert.match(m, /on conflict \(user_id, stream_key\) do nothing/);
  assert.match(up, /case when o\.dismissed then 'dismissed' else 'confirmed' end/);
  assert.match(up, /lower\(o\.billing_frequency\)/);
  assert.match(m, /order by t\.booking_date desc\s+limit 1/);
  assert.match(m, /t\.merchant_key is not null/);
});

test('rollback drops the functions and the table', () => {
  assert.match(down, /drop function public\.stream_action\(uuid, text, jsonb\)/);
  assert.match(down, /drop function public\.upsert_detected_streams\(uuid, jsonb\)/);
  assert.match(down, /drop table public\.recurring_streams/);
});
