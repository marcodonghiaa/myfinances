-- Seed for the 20261103000000 repair rehearsal (local only). Rerunnable: clears its fixed-UUID rows first.
-- Run: supabase/rehearsals/repair_collapsed_accounts.seed.sql, then repair_collapsed_accounts.assert.sql.
delete from public.net_worth_snapshots where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.accounts where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';

insert into auth.users (id, instance_id, aud, role, email)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'repair-test@example.test');

-- b1 collapsed: pocket 1 uid, last pocket's GBP currency and hash. b2 normal, untouched by the repair.
insert into public.accounts (uid, iban, currency, user_id, identification_hash) values
  ('00000000-0000-0000-0000-0000000000b1', 'LT00TEST', 'GBP', '00000000-0000-0000-0000-0000000000a1', 'h-gbp'),
  ('00000000-0000-0000-0000-0000000000b2', 'LT00OK',   'EUR', '00000000-0000-0000-0000-0000000000a1', 'h-ok');

-- b1's older snapshot is GBP, newest EUR: a wrong sort direction would leave b1 on GBP.
insert into public.net_worth_snapshots (account_uid, currency, amount, snapshot_date, user_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'GBP', 100, '2026-10-01', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1', 'EUR', 120, '2026-10-02', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'EUR', 50,  '2026-10-02', '00000000-0000-0000-0000-0000000000a1');
