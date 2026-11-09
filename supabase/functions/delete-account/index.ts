// Supabase Edge Function: delete-account
//
// Deletes the signed-in user and everything stored for them on this instance, after closing
// their Enable Banking sessions so their banks stop sharing data. Body: { "confirm": "DELETE" }.
// Every row that belongs to the user goes with them (foreign keys cascade from auth.users,
// migration 20261125000000). The Enable Banking key and the instance settings are untouched.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { closeSessions } from "../_shared/link-accounts.ts";

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
  const userId = userData.user.id;

  const body = await req.json().catch(() => null);
  if (body?.confirm !== "DELETE") return json({ error: "Type DELETE to confirm" }, 400);

  const { data: sessions, error: sessionsError } = await service
    .from("bank_sessions").select("session_id").eq("user_id", userId);
  if (sessionsError) {
    console.error(`delete-account: sessions not read: ${errorTag(sessionsError)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  // Links made before bank_sessions existed have no stored session: those expire on their own
  // (at most 180 days) and can be revoked from the bank's own app meanwhile.
  await closeSessions((sessions ?? []).map((s: { session_id: string }) => s.session_id)).catch((err) => {
    console.error(`delete-account: sessions not closed: ${errorTag(err)}`);
  });

  const { error } = await service.auth.admin.deleteUser(userId);
  if (error) {
    console.error(`delete-account failed: ${errorTag(error)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  return json({ ok: true });
}));
