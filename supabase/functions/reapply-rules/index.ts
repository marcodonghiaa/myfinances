// Supabase Edge Function: reapply-rules
//
// The Rules page's "Apply to past transactions". Body: { "apply": false } previews how many
// transactions your current rules would re-categorize (plus a few examples); { "apply": true }
// does it. Runs as the signed-in user, so RLS limits it to their own rules and transactions.
// Categories you set by hand are never changed (see _shared/reapply-rules.ts).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { reapplyRules } from "../_shared/reapply-rules.ts";

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
  try {
    return json(await reapplyRules(asUser, userData.user.id, body?.apply === true));
  } catch (err) {
    console.error(`reapply-rules failed: ${errorTag(err)}`);
    return json({ error: "Couldn't apply your rules, please try again" }, 500);
  }
}));
