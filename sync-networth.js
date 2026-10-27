const { checkSessionExpiry } = require('./session-check');

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getAccounts, getAllUserIds } = require('./accounts');
const { getToken } = require('./eb-token');
const { fetchWithTimeout } = require('./http');
const { errorTag } = require('./log-safe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);


async function getBalances(token, uid) {
  const res = await fetchWithTimeout(`https://api.enablebanking.com/accounts/${uid}/balances`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`API error ${res.status}`), { status: res.status });
  return res.json();
}

async function main() {
  const token = getToken();
  const today = new Date().toISOString().slice(0, 10);
  const userIds = await getAllUserIds(supabase);
  const rows = [];

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
      try {
        const data = await getBalances(token, account.uid);
        const balance = data.balances?.[0];

        if (!balance) {
          console.log('No balance returned.');
          continue;
        }

        const amount = parseFloat(balance.balance_amount.amount);

        rows.push({
          account_uid: account.uid,
          currency: balance.balance_amount.currency,
          amount,
          snapshot_date: today,
          user_id: userId,
        });
      } catch (err) {
        console.error(`Failed to fetch balance: ${errorTag(err)}`);
      }
    }
  }

  if (rows.length > 0) {
    // one snapshot per account per day — upsert avoids duplicate rows if run twice same day
    const { error } = await supabase
      .from('net_worth_snapshots')
      .upsert(rows, { onConflict: 'account_uid,snapshot_date' });

    if (error) {
      console.error(`Supabase insert error: ${errorTag(error)}`);
    } else {
      console.log(`\nSaved ${rows.length} snapshot(s) for ${today}.`);
    }
  }
}

main().catch((err) => {
  console.error(`Failed: ${errorTag(err)}`);
  process.exit(1);
});
