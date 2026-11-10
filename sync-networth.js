const { checkSessionExpiry } = require('./session-check');

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getAccounts, getAllUserIds, ebAccountId, idsPatchFromDetails, accountType, EB_REJECTED_STATUSES } = require('./accounts');
const { getToken } = require('./eb-token');
const { fetchWithTimeout } = require('./http');
const { errorTag } = require('./log-safe');

async function getEb(fetch, token, path) {
  const res = await fetch(`https://api.enablebanking.com/accounts/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // code = EB's error name (e.g. EXPIRED_SESSION) when the body is JSON; the body itself is never kept.
    const body = await res.json().catch(() => null);
    // Only an all-caps name: errorTag prints the code, so free text from EB never reaches the log.
    const code = /^[A-Z_]+$/.test(body?.error) ? body.error : undefined;
    throw Object.assign(new Error(`API error ${res.status}`), { status: res.status, ...(code && { code }) });
  }
  return res.json();
}

// Older rows lack identification_hash (and iban) or account_type: ask EB once and store them.
// A bank that sends no type gets 'checking' (what unknown counts as), so the call is not
// repeated. Best effort: any failure here is logged and the balance sync goes on.
async function fillMissingIds(fetch, supabase, token, account) {
  const needType = account.account_type === null;
  if (account.identification_hash && !needType) return;
  try {
    const details = await getEb(fetch, token, `${ebAccountId(account)}/details`);
    const patch = {};
    if (!account.identification_hash) {
      const ids = idsPatchFromDetails(details);
      if (ids) Object.assign(patch, ids);
      else console.error('Account ids not filled: no hash in details');
    }
    if (needType) patch.account_type = accountType(details?.cash_account_type) ?? 'checking';
    if (Object.keys(patch).length === 0) return;
    const { error } = await supabase.from('accounts').update(patch).eq('uid', account.uid);
    if (error) throw error;
  } catch (err) {
    console.error(`Account ids not filled: ${errorTag(err)}`);
  }
}

// EXPIRED_SESSION: the bank closed the consent before consent_valid_until. Ending it today
// shows the Renew banner and the consent push. Never moves a date later; best effort like
// fillMissingIds. Returns whether the row was marked.
async function markForRenewal(supabase, account, err, today) {
  if (err.code !== 'EXPIRED_SESSION') return false;
  if (account.consent_valid_until && account.consent_valid_until.slice(0, 10) <= today) return false;
  try {
    // Compare-and-set on the date read at start: a Renew during the sync writes a new date
    // that a stale EXPIRED_SESSION must not overwrite.
    const query = supabase.from('accounts').update({ consent_valid_until: today }).eq('uid', account.uid);
    const { error } = await (account.consent_valid_until
      ? query.eq('consent_valid_until', account.consent_valid_until)
      : query.is('consent_valid_until', null));
    if (error) throw error;
    return true;
  } catch (updateErr) {
    console.error(`Account not marked for renewal: ${errorTag(updateErr)}`);
    return false;
  }
}

// EB is asked with the id it answers to now; the snapshot is saved under the PK (uid).
// Never throws for EB failures: rejected carries the status when EB refuses the id.
async function syncAccountBalance({ fetch, supabase }, token, account, userId, today) {
  await fillMissingIds(fetch, supabase, token, account);
  try {
    const data = await getEb(fetch, token, `${ebAccountId(account)}/balances`);
    const balance = data.balances?.[0];
    if (!balance) {
      console.log('No balance returned.');
      return { row: null, rejected: null };
    }
    const row = {
      account_uid: account.uid,
      currency: balance.balance_amount?.currency,
      amount: parseFloat(balance.balance_amount?.amount),
      snapshot_date: today,
      user_id: userId,
    };
    // An unreadable balance would fail the whole day's save for every account; skip just this one.
    if (!Number.isFinite(row.amount) || !row.currency) {
      console.error('Balance unreadable, skipped for this account.');
      return { row: null, rejected: null };
    }
    return { row, rejected: null };
  } catch (err) {
    console.error(`Failed to fetch balance: ${errorTag(err)}`);
    const renewed = await markForRenewal(supabase, account, err, today);
    return { row: null, rejected: EB_REJECTED_STATUSES.has(err.status) ? err.status : null, renewed };
  }
}

async function saveOneByOne(supabase, rows) {
  let saved = 0;
  for (const row of rows) {
    const { error } = await supabase
      .from('net_worth_snapshots')
      .upsert(row, { onConflict: 'account_uid,snapshot_date' });
    if (error) console.error(`Snapshot not saved: ${errorTag(error)}`);
    else saved++;
  }
  return saved;
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const token = getToken();
  const today = new Date().toISOString().slice(0, 10);
  const userIds = await getAllUserIds(supabase);
  const rows = [];
  let rejectedCount = 0;
  let renewalCount = 0;

  for (const [u, userId] of userIds.entries()) {
    let accounts;
    try {
      await checkSessionExpiry(supabase, userId);
      accounts = await getAccounts(supabase, userId);
    } catch (err) {
      // One user's failure shouldn't stop everyone after them from syncing.
      console.error(`Skipping user ${u + 1}/${userIds.length}: ${errorTag(err)}`);
      continue;
    }

    for (const [i, account] of accounts.entries()) {
      console.log(`\n=== Account ${i + 1}/${accounts.length} ===`);
      const { row, rejected, renewed } = await syncAccountBalance({ fetch: fetchWithTimeout, supabase }, token, account, userId, today);
      if (row) rows.push(row);
      if (rejected) rejectedCount++;
      if (renewed) renewalCount++;
    }
  }

  if (rejectedCount > 0) console.error(`EB refused ${rejectedCount} account(s) (dead or expired account id)`);
  if (renewalCount > 0) console.error(`Marked ${renewalCount} account(s) for renewal (bank closed access early)`);

  if (rows.length > 0) {
    // one snapshot per account per day — upsert avoids duplicate rows if run twice same day
    const { error } = await supabase
      .from('net_worth_snapshots')
      .upsert(rows, { onConflict: 'account_uid,snapshot_date' });

    if (!error) {
      console.log(`\nSaved ${rows.length} snapshot(s) for ${today}.`);
    } else {
      // One bad row fails the whole statement: save one by one so the others still land.
      console.error(`Supabase insert error, saving one by one: ${errorTag(error)}`);
      const saved = await saveOneByOne(supabase, rows);
      console.log(`\nSaved ${saved}/${rows.length} snapshot(s) for ${today}.`);
      if (saved < rows.length) process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}

module.exports = { syncAccountBalance, saveOneByOne };
