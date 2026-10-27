const { errorTag } = require('./log-safe');

// ponytail: hardcoded allowlist, add a per-user setting if this ever needs
// to be user-configurable instead of a personal tuning knob.
const DISCRETIONARY_CATEGORIES = ['Shopping', 'Entertainment', 'Dine Out', 'Experiences'];
const MIN_AMOUNT = 15; // native currency, no cross-currency threshold — small MVP gap
const MIN_AGE_HOURS = 3;
const MAX_AGE_HOURS = 24; // don't blast stale transactions if the job was down
const MAX_BOOKING_AGE_DAYS = 7; // = sync overlap: a late-posted purchase still counts

async function fetchEligibleTransactions(supabase, userId, now) {
  const bookingFloor = new Date(now.getTime() - MAX_BOOKING_AGE_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('transactions')
    .select('entry_reference, account_uid, creditor_name, amount, currency, category')
    .eq('user_id', userId)
    .eq('credit_debit_indicator', 'DBIT')
    .in('category', DISCRETIONARY_CATEGORIES)
    .is('worth_it', null) // not "already pushed" -- "not yet answered" (in-app or via push)
    .is('worth_it_prompted_at', null)
    .gte('amount', MIN_AMOUNT)
    .lte('created_at', new Date(now.getTime() - MIN_AGE_HOURS * 3600 * 1000).toISOString())
    .gte('created_at', new Date(now.getTime() - MAX_AGE_HOURS * 3600 * 1000).toISOString())
    .or(`booking_date.gte.${bookingFloor},booking_date.is.null`);
  if (error) throw error;
  return data;
}

// One transaction: the specific deep-link prompt. Several at once (e.g. an hour
// where multiple purchases all crossed the 3h line together, or an old backlog
// from a period without sync) become ONE digest push instead of a stack
// of separate notifications for the same shopping spree.
function buildPayload(transactions) {
  if (transactions.length === 1) {
    const tx = transactions[0];
    return {
      title: 'Worth it?',
      body: `${tx.amount} ${tx.currency} at ${tx.creditor_name || 'a merchant'} — ${tx.category}`,
      url: `/transactions?highlight=${encodeURIComponent(tx.entry_reference)}`,
    };
  }
  const names = transactions.slice(0, 3).map((t) => t.creditor_name || 'a merchant');
  const extra = transactions.length > 3 ? ` +${transactions.length - 3} more` : '';
  return {
    title: 'Worth it?',
    body: `${transactions.length} purchases today: ${names.join(', ')}${extra}`,
    url: '/transactions',
  };
}

async function main() {
  require('dotenv').config();
  const USER_ID = process.env.USER_ID;
  if (!USER_ID) throw new Error('USER_ID missing from .env');
  if (!process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY missing from .env');
  const { createClient } = require('@supabase/supabase-js');
  const { fetchSubscriptions, sendToAllSubscriptions } = require('./push');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

  const transactions = await fetchEligibleTransactions(supabase, USER_ID, new Date());
  if (transactions.length === 0) {
    console.log('No eligible transactions to prompt.');
    return;
  }

  const subscriptions = await fetchSubscriptions(supabase, USER_ID);
  if (subscriptions.length === 0) {
    console.log(`${transactions.length} eligible transaction(s) but no push subscription on file.`);
    return;
  }

  const delivered = await sendToAllSubscriptions(supabase, subscriptions, buildPayload(transactions));
  if (!delivered) {
    console.error('Push delivery failed for every subscription -- not marking prompted, will retry next run.');
    return;
  }

  const now = new Date().toISOString();
  let failed = 0;
  for (const tx of transactions) {
    const { error } = await supabase
      .from('transactions')
      .update({ worth_it_prompted_at: now })
      .eq('account_uid', tx.account_uid)
      .eq('entry_reference', tx.entry_reference);
    if (error) failed++;
  }
  if (failed > 0) console.error(`Failed to mark ${failed} transaction(s) prompted.`);
  console.log(`Prompted ${transactions.length} transaction(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}

module.exports = { fetchEligibleTransactions, buildPayload };
