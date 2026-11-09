// Supabase Edge Function: complete-bank-consent
//
// Last step of self-serve bank linking, called by the signed-in dashboard with the { code, state }
// that bank-consent-callback handed it. The pending row is deleted through the caller's own
// session, so RLS only finds it when the caller is the user who started this link: someone who
// completes another user's consent URL gets "Invalid or expired" and links nothing.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { burnCode, linkAccounts } from "../_shared/link-accounts.ts";
import { claimConsent, isConsentInput } from "../_shared/consent-claim.ts";
import { startFirstSync } from "../_shared/first-sync.ts";
import { parseSecretKeys } from "../_shared/secret-key.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));

const service = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(serveWithCors(async (req, json) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );
  const { data: userData, error: userError } = await asUser.auth.getUser();
  if (userError || !userData.user) return json({ error: "Not signed in" }, 401);

  const body = await req.json().catch(() => null);
  if (!isConsentInput(body)) return json({ error: "Missing code or state" }, 400);

  const claim = await claimConsent(asUser, body.state, userData.user.id, Date.now());
  if ("error" in claim) {
    await burnCode(body.code);
    return json({ error: claim.error }, 403);
  }

  const result = await linkAccounts(service, userData.user.id, body.code);
  if ("error" in result) return json({ error: result.error }, 502);

  // Transactions now, not at the next cron run; the reply does not wait for it.
  EdgeRuntime.waitUntil(startFirstSync(
    Deno.env.get("SUPABASE_URL")!,
    SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0],
    result.accountUids,
  ));
  return json(result.params);
}));
