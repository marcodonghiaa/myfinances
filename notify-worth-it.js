require('dotenv').config();
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const USER_ID = process.env.USER_ID;

// ponytail: hardcoded allowlist, add a per-user setting if this ever needs
// to be user-configurable instead of a personal tuning knob.
const DISCRETIONARY_CATEGORIES = ['Shopping', 'Entertainment', 'Dine Out', 'Experiences'];
const MIN_AMOUNT = 15; // native currency, no cross-currency threshold — small MVP gap
const MIN_AGE_HOURS = 3;
const MAX_AGE_HOURS = 24; // don't blast stale transactions if the job was down

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function fetchEligibleTransactions() {
  const { data, error } = await supabase
    .from('transactions')
    .select('entry_reference, creditor_name, amount, currency, category')
    .eq('user_id', USER_ID)
    .eq('credit_debit_indicator', 'DBIT')
    .in('category', DISCRETIONARY_CATEGORIES)
    .is('worth_it', null) // not "already pushed" -- "not yet answered" (in-app or via push)
    .gte('amount', MIN_AMOUNT)
    .lte('created_at', new Date(Date.now() - MIN_AGE_HOURS * 3600 * 1000).toISOString())
    .gte('created_at', new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString());
  if (error) throw error;
  return data;
}

async function fetchSubscriptions() {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', USER_ID);
  if (error) throw error;
  return data;
}

async function sendToAllSubscriptions(subscriptions, payload) {
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // subscription dead (uninstalled, permission revoked) — stop trying it
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error(`Push failed for subscription ${sub.id}:`, err.message);
      }
    }
  }
}

async function main() {
  if (!USER_ID) throw new Error('USER_ID missing from .env');
  if (!process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY missing from .env');

  const transactions = await fetchEligibleTransactions();
  if (transactions.length === 0) {
    console.log('No eligible transactions to prompt.');
    return;
  }

  const subscriptions = await fetchSubscriptions();
  if (subscriptions.length === 0) {
    console.log(`${transactions.length} eligible transaction(s) but no push subscription on file.`);
    return;
  }

  for (const tx of transactions) {
    const payload = {
      title: 'Worth it?',
      body: `€${tx.amount} at ${tx.creditor_name || 'a merchant'} — ${tx.category}`,
      url: '/transactions',
    };
    await sendToAllSubscriptions(subscriptions, payload);

    const { error } = await supabase
      .from('transactions')
      .update({ worth_it_prompted_at: new Date().toISOString() })
      .eq('entry_reference', tx.entry_reference);
    if (error) console.error(`Failed to mark ${tx.entry_reference} prompted:`, error.message);

    console.log(`Prompted: ${tx.creditor_name} (${tx.amount} ${tx.currency})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
