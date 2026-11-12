// v_transactions_eur's payer_name on a real Postgres: the payer on an incoming payment, your own
// name for the row first, and still only your own rows (the view runs as the caller). Needs psql
// and RLS_TEST_DATABASE_URL (a superuser URL to a throwaway server); skipped without it.
// Only the tables the view reads are created, with the columns it reads, so this runs on a plain
// Postgres without the Supabase extensions the full migration chain needs.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const url = process.env.RLS_TEST_DATABASE_URL;
const skip = url ? false : 'set RLS_TEST_DATABASE_URL to run';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const db = `payer_name_${process.pid}`;
const dbUrl = () => url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${db}`);

function psql(target, args) {
  return execFileSync('psql', [target, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const as = (sub, sql) =>
  psql(dbUrl(), [
    '-c',
    `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${sub}"}'; ${sql}; rollback;`,
  ]);

const TABLES = `
create table public.fx_rates (currency text, date date, rate_to_eur numeric);
create table public.transactions (
  user_id uuid not null, entry_reference text not null, account_uid uuid not null, booking_date date,
  category text, creditor_name text, debtor_name text, custom_name text, currency text not null,
  amount numeric not null, transaction_type text, credit_debit_indicator text, created_at timestamptz,
  worth_it text, personal_amount numeric, flow_type text, owed_by text, owed_settled boolean not null default false,
  settled_at timestamptz, refund_of text, note text, tags text[], deleted_at timestamptz);
alter table public.transactions enable row level security;
create policy own on public.transactions for select using ((select auth.uid()) = user_id);
grant select on public.transactions, public.fx_rates to authenticated;`;

test('v_transactions_eur payer_name', { skip }, async (t) => {
  psql(url, ['-c', `create database ${db}`]);
  t.after(() => psql(url, ['-c', `drop database if exists ${db} with (force)`]));
  psql(dbUrl(), ['-f', 'supabase/tests/supabase-shim.sql']);
  psql(dbUrl(), ['-c', TABLES]);
  psql(dbUrl(), ['-f', 'supabase/migrations/20261209000000_transactions_payer_name.sql']);
  psql(dbUrl(), [
    '-c',
    `insert into public.transactions (user_id, entry_reference, account_uid, booking_date, creditor_name, debtor_name, custom_name, currency, amount, credit_debit_indicator) values
       ('${A}', 'salary', gen_random_uuid(), '2026-11-01', 'Me Myself', 'Acme Srl', null, 'EUR', 2000, 'CRDT'),
       ('${A}', 'renamed', gen_random_uuid(), '2026-11-02', null, 'Old Payer', 'Freelance gig', 'EUR', 300, 'CRDT'),
       ('${A}', 'nobody', gen_random_uuid(), '2026-11-03', null, null, null, 'EUR', 5, 'CRDT'),
       ('${B}', 'other', gen_random_uuid(), '2026-11-01', null, 'Secret Payer', null, 'EUR', 9, 'CRDT');`,
  ]);

  await t.test('names the payer, preferring the name you gave the row', () => {
    assert.strictEqual(
      as(A, "select string_agg(entry_reference || '=' || coalesce(payer_name, '∅'), ',' order by entry_reference) from public.v_transactions_eur"),
      'nobody=∅,renamed=Freelance gig,salary=Acme Srl',
    );
  });

  await t.test("keeps another user's payers out", () => {
    assert.strictEqual(as(B, 'select string_agg(payer_name, \',\') from public.v_transactions_eur'), 'Secret Payer');
    assert.strictEqual(as(B, "select count(*) from public.v_transactions_eur where payer_name = 'Acme Srl'"), '0');
  });

  await t.test('re-applying the migration is safe', () => {
    psql(dbUrl(), ['-f', 'supabase/migrations/20261209000000_transactions_payer_name.sql']);
    psql(dbUrl(), ['-f', 'supabase/rollbacks/20261209000000_transactions_payer_name.down.sql']);
    assert.strictEqual(as(A, "select payer_name from public.v_transactions_eur where entry_reference = 'salary'"), 'Acme Srl');
  });
});
