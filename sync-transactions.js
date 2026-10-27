const { checkSessionExpiry } = require('./session-check');

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getAccounts, getAllUserIds, ebAccountId, EB_REJECTED_STATUSES } = require('./accounts');
const { getToken } = require('./eb-token');
const { buildRows } = require('./transaction-rows');
const { fetchWithTimeout } = require('./http');
const { errorTag } = require('./log-safe');
const { loadCursors, saveCursors, freshUnsyncedAccounts } = require('./sync-state');

const SYNC_STATE_FILE = process.env.SYNC_STATE_FILE || 'last-sync.json';
const OVERLAP_DAYS = 7;
// --new-only: sync just the banks linked in the last hour that have never synced, so a new
// user sees transactions minutes after linking instead of at the next 6-hour run.
// scheduler.js runs it every few minutes; other accounts aren't touched (banks cap calls).
const NEW_ONLY = process.argv.includes('--new-only');
const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

async function getTransactionsPage(fetch, token, ebId, dateFrom, continuationKey) {
  const params = new URLSearchParams({ date_from: dateFrom });
  if (continuationKey) params.set('continuation_key', continuationKey);

  const res = await fetch(`https://api.enablebanking.com/accounts/${ebId}/transactions?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`API error ${res.status}`), { status: res.status });
  return res.json();
}

async function getAllTransactions(fetch, token, ebId, dateFrom) {
  let all = [];
  let continuationKey = null;
  do {
    const data = await getTransactionsPage(fetch, token, ebId, dateFrom, continuationKey);
    all = all.concat(data.transactions || []);
    continuationKey = data.continuation_key || null;
  } while (continuationKey);
  return all;
}

// EB is asked with the id it answers to now; rows and the cursor stay under the PK (uid).
// Never throws for EB failures: rejected carries the status when EB refuses the id.
async function syncAccountTransactions({ fetch, supabase }, token, account, userId, lastSync, today) {
  // Re-fetch an overlap before the cursor: banks post transactions days after their
  // booking_date, so a cursor of "today" would skip them forever. Upsert dedupes.
  const dateFrom = lastSync[account.uid]
    ? new Date(Date.parse(lastSync[account.uid]) - OVERLAP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
    : new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`syncing since ${dateFrom}`);

  try {
    const transactions = await getAllTransactions(fetch, token, ebAccountId(account), dateFrom);
    const rows = buildRows(transactions, account.uid, userId);

    if (rows.length === 0) {
      console.log('No new transactions.');
    } else {
      const { error } = await supabase
        .from('transactions')
        .upsert(rows, { onConflict: 'account_uid,entry_reference' }); // dedup, Actual-Budget-style
      if (error) {
        console.error(`Supabase insert error: ${errorTag(error)}`);
        return { upserted: 0, rejected: null };
      }
      console.log(`Upserted ${rows.length} transactions.`);
    }

    lastSync[account.uid] = today;
    return { upserted: rows.length, rejected: null };
  } catch (err) {
    // One bank's consent expiring or API hiccup shouldn't stop the others from syncing.
    console.error(`Failed to sync: ${errorTag(err)}`);
    return { upserted: 0, rejected: EB_REJECTED_STATUSES.has(err.status) ? err.status : null };
  }
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const token = getToken();
  const lastSync = await loadCursors(supabase, SYNC_STATE_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const userIds = await getAllUserIds(supabase);
  let rejectedCount = 0;

  for (const [u, userId] of userIds.entries()) {
    let accounts;
    try {
      if (!NEW_ONLY) await checkSessionExpiry(supabase, userId);
      accounts = await getAccounts(supabase, userId);
      if (NEW_ONLY) accounts = freshUnsyncedAccounts(accounts, lastSync, Date.now(), NEW_ACCOUNT_WINDOW_MS);
    } catch (err) {
      // One user's failure shouldn't stop everyone after them from syncing.
      console.error(`Skipping user ${u + 1}/${userIds.length}: ${errorTag(err)}`);
      continue;
    }

    for (const [i, account] of accounts.entries()) {
      console.log(`\n=== Account ${i + 1}/${accounts.length} ===`);
      const { rejected } = await syncAccountTransactions(
        { fetch: fetchWithTimeout, supabase }, token, account, userId, lastSync, today,
      );
      if (rejected) rejectedCount++;
    }
  }

  if (rejectedCount > 0) console.error(`EB refused ${rejectedCount} account(s) (dead or expired account id)`);

  await saveCursors(supabase, SYNC_STATE_FILE, lastSync);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}

module.exports = { syncAccountTransactions };
