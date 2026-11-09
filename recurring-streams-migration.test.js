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
  assert.match(up, /revoke all on public\.recurring_streams from anon, authenticated/);
  assert.match(up, /grant select on public\.recurring_streams to authenticated/);
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

test('override migration handles aggregators, deleted/credit rows, duplicates; set_cadence validates', () => {
  assert.match(up, /select round\(abs\(m\.amount\), 2\) as amt|select distinct round\(abs\(m\.amount\), 2\) as amt/);
  assert.match(up, /order by a\.amt\s+limit case when o\.dismissed then null else 1 end/);
  assert.match(up, /abs\(n\.amount\), n\.booking_date/);
  assert.match(up, /display_name, typical_amount, last_charged/);
  assert.match(up, /user_id uuid not null references auth\.users \(id\) on delete cascade/);
  assert.match(up, /t\.deleted_at is null and t\.credit_debit_indicator = 'DBIT'/);
  assert.match(up, /order by o\.dismissed\s+on conflict/); // the name you kept wins
  const fn = fnBody('stream_action');
  assert.match(fn, /raise exception 'Invalid cadence args'/);
  assert.match(fn, /custom_value'\)::int > 0/);
});

test('schedule comment says 15 minutes after post-sync', () => {
  assert.match(fs.readFileSync('supabase/migrations/20261120000001_schedule_detect_recurring.sql', 'utf8'), /^-- [^\n]*15 minutes after post-sync/);
});

test('rollback drops the functions and the table', () => {
  assert.match(down, /drop function public\.stream_action\(uuid, text, jsonb\)/);
  assert.match(down, /drop function public\.upsert_detected_streams\(uuid, jsonb\)/);
  assert.match(down, /drop table public\.recurring_streams/);
});

test('R7: override import fills typical_amount_eur from your EUR share of the newest live debit', () => {
  const m = up.slice(up.indexOf('insert into public.recurring_streams (\n  user_id, stream_key, merchant_key, account_uid, currency, display_name'));
  assert.match(m, /source, updated_at, typical_amount_eur\)/);
  assert.match(m, /'override', now\(\), e\.eur/);
  assert.match(m, /left join lateral \(\s+select abs\(v\.personal_signed_amount_eur\) as eur/);
  assert.match(m, /join public\.v_transactions_eur v\s+on v\.user_id = t\.user_id and v\.account_uid = t\.account_uid and v\.entry_reference = t\.entry_reference/);
  assert.match(m, /t\.merchant_key = n\.merchant_key and t\.account_uid = n\.account_uid/);
  assert.match(m, /\(s\.amt is null or round\(abs\(t\.amount\), 2\) = s\.amt\)\s+order by t\.booking_date desc\s+limit 1\s+\) e on true/);
});

const v2 = read('supabase/migrations/20261121000000_recurring_streams_v2.sql');
const v2down = fs.readFileSync('supabase/rollbacks/20261121000000_recurring_streams_v2.down.sql', 'utf8');
const at = (re) => {
  const i = v2.search(re);
  assert.notEqual(i, -1, String(re));
  return i;
};

test('v2: only old-shape keys (merchant|account|CUR[|amount]) are rekeyed, currency dropped', () => {
  assert.match(v2, /r\.merchant_key \|\| '\|' \|\| coalesce\(r\.account_uid::text, 'null'\) \|\| '\|' as p/);
  assert.match(v2, /where left\(stream_key, length\(p\)\) = p/);
  assert.match(v2, /rest ~ '\^\[A-Z\]\{3\}\(\\\|\[0-9\]\+\(\\\.\[0-9\]\+\)\?\)\?\$'/);
  assert.match(v2, /left\(p, -1\) \|\| coalesce\('\|' \|\| nullif\(substr\(rest, 5\), ''\), ''\) as new_key/);
  assert.match(v2, /update public\.recurring_streams r\s+set stream_key = o\.new_key\s+from v2_old_keys o\s+where r\.id = o\.id/);
});

test('v2: detector-only rows go first, then collisions keep confirmed > undecided > dismissed, newest first', () => {
  const del = at(/delete from public\.recurring_streams r\s+where r\.user_status is null and r\.source = 'bank'/);
  const dedupe = at(/partition by user_id, new_key/);
  const rekey = at(/set stream_key = o\.new_key/);
  assert.ok(del < dedupe && dedupe < rekey, 'order: delete detector rows, dedupe, rekey');
  assert.match(v2, /o\.id = r\.id or \(o\.user_id = r\.user_id and o\.new_key = r\.stream_key\)/);
  assert.match(v2, /order by case user_status when 'confirmed' then 0 when 'dismissed' then 2 else 1 end,\s+updated_at desc nulls last, id/);
  assert.match(v2, /where r\.id = d\.id and d\.rn > 1/);
});

test('v2: kept override name wins over a dismissed one on the same stream, after the rekey', () => {
  const kept = at(/set user_status = 'confirmed'/);
  assert.ok(kept > at(/set stream_key = o\.new_key/));
  const d = v2.slice(kept);
  assert.match(d, /where not o\.dismissed and \(o\.billing_frequency is not null or o\.custom_interval_value is not null\)/);
  assert.match(d, /order by t\.booking_date desc\s+limit 1/);
  assert.match(d, /case when o\.custom_interval_value is not null then 'custom' else lower\(o\.billing_frequency\) end/);
  assert.match(d, /min\(round\(abs\(m\.amount\), 2\)\) as amt/); // aggregators: same amount only
  assert.match(d, /r\.source = 'override' and r\.user_status = 'dismissed'/);
  assert.match(d, /display_name = k\.creditor_name/);
});

test('v2: typical_amount_eur backfill only fills nulls, from the newest live debit', () => {
  const e = v2.slice(at(/set typical_amount_eur = \(/));
  assert.match(e, /select abs\(v\.personal_signed_amount_eur\)/);
  assert.match(e, /t\.deleted_at is null and t\.credit_debit_indicator = 'DBIT'/);
  assert.match(e, /order by t\.booking_date desc\s+limit 1\)\s+where r\.typical_amount_eur is null/);
  assert.match(v2, /drop table v2_old_keys;/);
});

test('v2 rollback restores both functions and states the data steps are a no-op', () => {
  assert.match(v2down, /data steps are a no-op on purpose/);
  const code = v2down.replace(/--.*$/gm, '');
  assert.equal(code.match(/create or replace function public\.(upsert_detected_streams|stream_action)\(/g).length, 2);
  assert.doesNotMatch(code, /\bdelete\b/i); // the restored upsert never deletes
  assert.match(code, /p_action = 'undismiss' then\s+update public\.recurring_streams set user_status = null/);
  assert.doesNotMatch(code, /\b(drop|alter)\b|delete from|insert into public\.recurring_streams \(\s+user_id, stream_key, merchant_key, account_uid, currency, display_name, typical_amount/i);
});

const v2fn = (name) => {
  const i = v2.indexOf(`function public.${name}(`);
  assert.notEqual(i, -1, name);
  return v2.slice(i, v2.indexOf('$$;', v2.indexOf('$$', i) + 2) + 3);
};

test('v2 upsert_detected_streams removes stale detector-only rows, never user choices; service role only', () => {
  const fn = v2fn('upsert_detected_streams');
  assert.match(fn, /security definer set search_path = public/);
  assert.doesNotMatch(fn.slice(fn.indexOf('do update set'), fn.indexOf('get diagnostics')), /user_status|user_cadence|custom_interval|source/);
  assert.match(fn, /delete from public\.recurring_streams s\s+where s\.user_id = p_user and s\.user_status is null and s\.source = 'bank'\s+and not exists \(select 1 from jsonb_array_elements\(p_rows\) e where e->>'stream_key' = s\.stream_key\)/);
  assert.match(v2, /revoke execute on function public\.upsert_detected_streams\(uuid, jsonb\) from public, anon, authenticated/);
  assert.match(v2, /grant execute on function public\.upsert_detected_streams\(uuid, jsonb\) to service_role/);
});

test('v2 stream_action: undismiss confirms a row the detector never filled, keeps ownership check and grants', () => {
  const fn = v2fn('stream_action');
  assert.match(fn, /security definer set search_path = public/);
  assert.match(fn, /user_id = auth\.uid\(\)/);
  for (const a of ['confirm', 'dismiss', 'undismiss', 'set_cadence']) assert.match(fn, new RegExp(`p_action = '${a}'`));
  assert.match(fn, /p_action = 'undismiss' then\s+update public\.recurring_streams\s+set user_status = case when detected_status is null then 'confirmed' end, updated_at = now\(\)/);
  assert.match(fn, /raise exception 'Unknown stream action/);
  assert.match(fn, /raise exception 'Invalid cadence args'/);
  assert.match(v2, /revoke execute on function public\.stream_action\(uuid, text, jsonb\) from public, anon/);
  assert.match(v2, /grant execute on function public\.stream_action\(uuid, text, jsonb\) to authenticated/);
});

const variantRule = /v\.transaction_type = 'Subscription' and v\.amount <> 0[\s\S]*?d\.creditor_name = v\.creditor_name and d\.dismissed/;

test('override import: a dismissed name skips its tombstone when a never-dismissed name keeps the stream visible', () => {
  const m = up.slice(up.indexOf('from public.subscription_billing_overrides'));
  assert.match(m, /and not \(o\.dismissed and n\.merchant_key not in \('paypal', 'apple', 'google'\) and exists \(/);
  assert.match(m, variantRule);
  assert.match(m, /v\.deleted_at is null and v\.credit_debit_indicator = 'DBIT'/);
});

const v3 = read('supabase/migrations/20261122000000_recurring_streams_variant_dismissal.sql');
const v3down = fs.readFileSync('supabase/rollbacks/20261122000000_recurring_streams_variant_dismissal.down.sql', 'utf8');

test('variant dismissal: only detected, non-aggregator imported dismissals go back to undecided', () => {
  assert.match(v3, /set user_status = null, updated_at = now\(\)/);
  assert.match(v3, /r\.source = 'override' and r\.user_status = 'dismissed' and r\.detected_status is not null/);
  assert.match(v3, /r\.merchant_key not in \('paypal', 'apple', 'google'\)/);
  assert.match(v3, /t\.transaction_type = 'Subscription' and t\.amount <> 0/);
  assert.match(v3, /t\.deleted_at is null and t\.credit_debit_indicator = 'DBIT'/);
  assert.match(v3, /d\.creditor_name = t\.creditor_name and d\.dismissed/);
  assert.doesNotMatch(v3, /\b(delete|insert|drop|alter)\b/i);
  assert.doesNotMatch(v3, /'confirmed'/); // never decides for you
});

test('variant dismissal rollback is a stated no-op', () => {
  assert.match(v3down, /No-op/);
  assert.doesNotMatch(v3down.replace(/--.*$/gm, ''), /\b(update|delete|insert|drop|alter)\b/i);
});
