const webpush = require('web-push');
const { errorTag } = require('./log-safe');

// Web Push shared by every notification script.
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function fetchSubscriptions(supabase, userId) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (error) throw error;
  return data;
}

// Returns true if at least one subscription actually received the push --
// callers use this to decide whether it's safe to mark work as done
// (a transient failure on every subscription should retry next run).
async function sendToAllSubscriptions(supabase, subscriptions, payload) {
  let delivered = false;
  for (const [i, sub] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      delivered = true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // subscription dead (uninstalled, permission revoked) — stop trying it
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error(`Push failed for subscription ${i + 1}/${subscriptions.length}: ${errorTag(err)}`);
      }
    }
  }
  return delivered;
}

module.exports = { fetchSubscriptions, sendToAllSubscriptions };
