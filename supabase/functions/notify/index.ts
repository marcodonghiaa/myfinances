// Supabase Edge Function: notify
//
// The launchd/Docker notifications, moved into Supabase. Body { "job": "worth-it" } sends the
// "Worth it?" prompts (every 30 minutes); { "job": "consent" } the bank-access reminders (daily).
// Push keys come from the VAPID_* secrets; without them nothing is sent. Callers send a project
// secret key on the apikey header, like sync-bank.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import type { SendPush } from "../_shared/push.ts";
import { runConsent, runWorthIt } from "../_shared/notify.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

const [subject, publicKey, privateKey] = ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].map((k) => Deno.env.get(k));
const send: SendPush | null = subject && publicKey && privateKey
  ? (sub, payload) =>
    webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
      vapidDetails: { subject, publicKey, privateKey },
      timeout: 10000,
    })
  : null;

Deno.serve(async (req) => {
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const job = (await req.json().catch(() => null))?.job;
  try {
    if (job === "worth-it") {
      const result = await runWorthIt(supabase, send);
      console.log(`notify worth-it: ${JSON.stringify(result)}`);
      return Response.json(result, { status: result.failedUsers > 0 ? 500 : 200 });
    }
    if (job === "consent") {
      const result = await runConsent(supabase, send);
      console.log(`notify consent: ${JSON.stringify(result)}`);
      return Response.json(result);
    }
    return Response.json({ error: 'job must be "worth-it" or "consent"' }, { status: 400 });
  } catch (err) {
    console.error(`notify ${job} failed: ${errorTag(err)}`);
    return Response.json({ error: "notify failed" }, { status: 500 });
  }
});
