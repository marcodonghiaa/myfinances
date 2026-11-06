// Deno port of push.js: Web Push shared by the notifications. The send function comes in from
// the caller (web-push in notify/index.ts), so this stays testable without npm.
import { errorTag } from "./log-safe.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
export type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };
/** Sends one push; throws an error with statusCode on a refused subscription. */
export type SendPush = (sub: Subscription, payload: string) => Promise<unknown>;

export async function fetchSubscriptions(db: Db, userId: string): Promise<Subscription[]> {
  const { data, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  if (error) throw error;
  return data;
}

// True if at least one subscription received the push: callers mark work done only then, so a
// failure on every subscription retries next run. send is null when the VAPID keys aren't set.
export async function sendToAllSubscriptions(db: Db, subscriptions: Subscription[], payload: unknown, send: SendPush | null) {
  if (!send) {
    console.log("Push keys (VAPID_*) are not set, so no notification was sent.");
    return false;
  }
  let delivered = false;
  for (const [i, sub] of subscriptions.entries()) {
    try {
      await send(sub, JSON.stringify(payload));
      delivered = true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // subscription dead (uninstalled, permission revoked): stop trying it
        await db.from("push_subscriptions").delete().eq("id", sub.id);
      } else {
        console.error(`Push failed for subscription ${i + 1}/${subscriptions.length}: ${status ? `HTTP ${status}` : errorTag(err)}`);
      }
    }
  }
  return delivered;
}
