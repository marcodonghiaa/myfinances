const webpush = require('web-push');
const { errorTag } = require('./log-safe');

// Web Push shared by every notification script. The keys are optional (env-check says so), so
// they are read when a push is sent, not when this file loads: loading it without them used to
// crash the consent notice even with nothing to send.
let configured = false;
function configure() {
  const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  if (!configured) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

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
  if (!configure()) {
    console.log('Push keys (VAPID_*) are not set, so no notification was sent.');
    return false;
  }
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
