const { checkSessionExpiry } = require('./session-check');

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { getAccounts, getAllUserIds } = require('./accounts');
const { getToken } = require('./eb-token');

const SYNC_STATE_FILE = 'last-sync.json';
const FETCH_TIMEOUT_MS = 60000; // matches Actual Budget's Enable Banking timeout
const OVERLAP_DAYS = 7;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

function loadLastSync() {
  if (fs.existsSync(SYNC_STATE_FILE)) return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
  return {};
}

function saveLastSync(state) {
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getTransactionsPage(token, uid, dateFrom, continuationKey) {
  const params = new URLSearchParams({ date_from: dateFrom });
  if (continuationKey) params.set('continuation_key', continuationKey);

  const res = await fetchWithTimeout(`https://api.enablebanking.com/accounts/${uid}/transactions?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getAllTransactions(token, uid, dateFrom) {
  let all = [];
  let continuationKey = null;
  do {
    const data = await getTransactionsPage(token, uid, dateFrom, continuationKey);
    all = all.concat(data.transactions || []);
    continuationKey = data.continuation_key || null;
  } while (continuationKey);
  return all;
}

function mapToRow(tx, accountUid, userId) {
  return {
    entry_reference: tx.entry_reference,
    account_uid: accountUid,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    credit_debit_indicator: tx.credit_debit_indicator,
    creditor_name: tx.creditor?.name || null,
    debtor_name: tx.debtor?.name || null,
    remittance_info: (tx.remittance_information || []).join(' '),
    booking_date: tx.booking_date,
    value_date: tx.value_date,
    bank_transaction_code: tx.bank_transaction_code?.code || null,
    raw: tx,
    user_id: userId,
  };
}

async function main() {
  const token = getToken();
  const lastSync = loadLastSync();
  const today = new Date().toISOString().slice(0, 10);
  const userIds = await getAllUserIds(supabase);

  for (const userId of userIds) {
    let accounts;
    try {
      await checkSessionExpiry(supabase, userId);
      accounts = await getAccounts(supabase, userId);
    } catch (err) {
      // One user's failure shouldn't stop everyone after them from syncing.
      console.error(`Skipping user ${userId}:`, err.message);
      continue;
    }

    for (const account of accounts) {
      // Re-fetch an overlap before the cursor: banks post transactions days after their
      // booking_date, so a cursor of "today" would skip them forever. Upsert dedupes.
      const dateFrom = lastSync[account.uid]
        ? new Date(Date.parse(lastSync[account.uid]) - OVERLAP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
        : new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      console.log(`\n=== ${account.label ?? account.currency} — syncing since ${dateFrom} ===`);

      try {
        const transactions = await getAllTransactions(token, account.uid, dateFrom);
        const rows = transactions.map(tx => mapToRow(tx, account.uid, userId));

        let upsertOk = true;
        if (rows.length > 0) {
          const { error } = await supabase
            .from('transactions')
            .upsert(rows, { onConflict: 'account_uid,entry_reference' }); // dedup, Actual-Budget-style

          if (error) {
            upsertOk = false;
            console.error(`Supabase insert error for ${account.label ?? account.currency}:`, error.message);
          } else {
            console.log(`Upserted ${rows.length} transactions.`);
          }
        } else {
          console.log('No new transactions.');
        }

        if (upsertOk) lastSync[account.uid] = today;
      } catch (err) {
        // One bank's consent expiring or API hiccup shouldn't stop the others from syncing.
        console.error(`Failed to sync ${account.label ?? account.currency}:`, err.message);
      }
    }
  }

  saveLastSync(lastSync);
}

main();