const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const strip = (p) => fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '');
const up = strip('supabase/migrations/20261130000000_account_types.sql');
const down = strip('supabase/rollbacks/20261130000000_account_types.down.sql');
const fn = (name) => up.slice(up.indexOf(`create function public.${name}`)).split('$$;')[0];
const view = up.slice(up.indexOf('create or replace view public.v_net_worth_daily'), up.indexOf('v_bank_accounts_latest'));

test('the type check replaces any existing one', () => {
  assert.ok(up.indexOf('drop constraint if exists accounts_account_type_check') < up.indexOf('add constraint accounts_account_type_check'));
  assert.match(up, /check \(account_type in \('checking', 'savings', 'credit_card', 'loan', 'investment', 'other'\)\)/);
});

test('debts subtract from net worth, liabilities_eur is the last column', () => {
  assert.match(view, /coalesce\(a\.account_type in \('credit_card', 'loan'\), false\) as is_debt/);
  assert.match(view, /sum\(x\.amount_eur\) filter \(where not x\.is_debt\) as bank_total_eur/);
  assert.match(view, /sum\(abs\(x\.amount_eur\)\) filter \(where x\.is_debt\) as liabilities_eur/);
  assert.match(view, /- coalesce\(b\.liabilities_eur, 0\) as total_eur/);
  assert.match(view, /coalesce\(b\.bank_total_eur, 0\) as bank_total_eur,/);
  assert.match(view, /portfolio_bonds_eur,\s+coalesce\(b\.liabilities_eur, 0\) as liabilities_eur\nfrom/);
});

test('manual balances carry forward without the 30-day limit, at each day\'s rate', () => {
  assert.match(view, /e\.snapshot_date > d\.snapshot_date - 31 or a\.manual/);
  assert.match(view, /case when a\.manual then e\.amount \* coalesce\(\s+\(select r\.rate_to_eur from fx_rates r\s+where r\.currency = e\.currency and r\.date <= d\.snapshot_date/);
});

test('deposits no longer count in net worth', () => {
  assert.doesNotMatch(view, /cd_holdings|cd_total_eur/);
});

test('the accounts list appends account_type and manual, and shows manual accounts with a balance', () => {
  assert.match(up, /a\.bank_country,\s+a\.account_type, a\.manual\n/);
  assert.match(up, /where not a\.manual or e\.snapshot_date is not null/);
});

for (const [name, sig] of [['set_account_type', 'uuid, text'], ['set_manual_balance', 'uuid, numeric'], ['add_manual_debt', 'text, numeric, text'], ['delete_manual_debt', 'uuid']]) {
  test(`${name} acts for the signed-in user only`, () => {
    const body = fn(name);
    assert.match(body, /security definer set search_path = (public|'')/);
    assert.match(body, /v_uid uuid := auth\.uid\(\)/);
    assert.match(body, /if v_uid is null then\s+raise exception 'not signed in'/);
    const re = (s) => s.replace(/[()]/g, '\\$&');
    assert.match(up, new RegExp(re(`revoke execute on function public.${name}(${sig}) from public, anon;`)));
    assert.match(up, new RegExp(re(`grant execute on function public.${name}(${sig}) to authenticated;`)));
  });
}

test('set_account_type and set_manual_balance check the owner', () => {
  assert.match(fn('set_account_type'), /where uid = p_account and user_id = v_uid;\s+if not found then\s+raise exception 'account not found'/);
  assert.match(fn('set_manual_balance'), /where uid = p_account and user_id = v_uid;\s+if not found then\s+raise exception 'account not found'/);
  assert.match(fn('set_manual_balance'), /if not v_account\.manual then\s+raise exception 'not a manual account'/);
});

test('add_manual_debt creates a manual loan with a balance for the caller', () => {
  const body = fn('add_manual_debt');
  assert.match(body, /values \(v_account, v_uid, v_currency, v_name, true, 'loan'\)/);
  assert.match(body, /values \(v_account, v_uid, v_currency, p_amount, current_date\)/);
});

test('rollback drops the RPCs, typed-in balances and the column, and restores the views', () => {
  for (const name of ['delete_manual_debt', 'add_manual_debt', 'set_manual_balance', 'set_account_type']) {
    assert.match(down, new RegExp(`drop function if exists public\\.${name}\\(`));
  }
  assert.match(down, /delete from public\.net_worth_snapshots s using public\.accounts a where a\.uid = s\.account_uid and a\.manual;/);
  assert.match(down, /drop view public\.v_net_worth_daily;\s+create view public\.v_net_worth_daily/);
  assert.doesNotMatch(down, /liabilities_eur|account_type in/);
  assert.match(down, /where not a\.manual\n/);
  assert.match(down, /grant select on public\.v_bank_accounts_latest, public\.v_net_worth_daily to authenticated, service_role;/);
  assert.ok(down.indexOf('drop column if exists account_type') > down.indexOf('create view public.v_net_worth_daily'));
});

test('add_manual_transaction never picks a debt account; rollback restores the old lookup', () => {
  const body = up.slice(up.indexOf('create or replace function public.add_manual_transaction')).split('$$;')[0];
  assert.match(body, /a\.currency = v_currency\n\s+and coalesce\(a\.account_type, 'checking'\) not in \('credit_card', 'loan'\);/);
  assert.match(body, /v_uid uuid := auth\.uid\(\)/);
  const old = down.slice(down.indexOf('create or replace function public.add_manual_transaction')).split('$$;')[0];
  assert.match(old, /a\.currency = v_currency;/);
  assert.ok(down.indexOf('add_manual_transaction') < down.indexOf('drop column if exists account_type'));
});

test('delete_manual_debt removes only the caller\'s manual debt and its balances', () => {
  const body = fn('delete_manual_debt');
  assert.match(body, /set search_path = ''/);
  assert.match(body, /where uid = p_account and user_id = v_uid;\s+if not found then\s+raise exception 'account not found'/);
  assert.match(body, /if not v_account\.manual or coalesce\(v_account\.account_type, ''\) not in \('credit_card', 'loan'\) then\s+raise exception 'not a manual debt'/);
  assert.match(body, /delete from public\.net_worth_snapshots where account_uid = v_account\.uid and user_id = v_uid;\s+delete from public\.accounts where uid = v_account\.uid and user_id = v_uid;/);
  assert.doesNotMatch(body, /delete from public\.transactions/);
});

test('a manual account can only be typed as a debt', () => {
  assert.match(fn('set_account_type'), /if v_manual and coalesce\(p_type, ''\) not in \('credit_card', 'loan'\) then\s+raise exception 'manual accounts can only be debts'/);
});

test('typed-in amounts are bounded', () => {
  for (const name of ['add_manual_debt', 'set_manual_balance']) {
    assert.match(fn(name), /if p_amount = 'NaN'::numeric or abs\(p_amount\) > 1e12 then\s+raise exception 'amount is out of range'/, name);
  }
});

test('delete_manual_debt refuses an account with transactions', () => {
  const body = fn('delete_manual_debt');
  assert.match(body, /if exists \(select 1 from public\.transactions where account_uid = v_account\.uid\) then\s+raise exception 'account has transactions'/);
  assert.ok(body.indexOf('account has transactions') < body.indexOf('delete from public.net_worth_snapshots'));
});
