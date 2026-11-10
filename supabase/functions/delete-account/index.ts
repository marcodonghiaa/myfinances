// Supabase Edge Function: delete-account
//
// Deletes the signed-in user and everything stored for them on this instance, then closes
// their Enable Banking sessions so their banks stop sharing data.
// Body: { "confirm": "DELETE", "password": "..." }. The password is checked again here, so a
// stolen session token alone can't erase an account.
// Every row that belongs to the user goes with them (foreign keys cascade from auth.users,
// migration 20261125000000). The Enable Banking key and the instance settings are untouched.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { closeSessions } from "../_shared/eb-sessions.ts";
import { MFA_REQUIRED, mfaSatisfied } from "../_shared/mfa.ts";

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
  if (!(await mfaSatisfied(asUser))) return json(MFA_REQUIRED, 403);
  const userId = userData.user.id;

  const body = await req.json().catch(() => null);
  if (body?.confirm !== "DELETE") return json({ error: "Type DELETE to confirm" }, 400);
  const password = body?.password;
  if (typeof password !== "string" || !password || password.length > 1024) {
    return json({ error: "Enter your password to confirm" }, 400);
  }
  const email = userData.user.email;
  if (!email) return json({ error: "This account has no password to confirm with" }, 400);
  const check = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: passwordError } = await check.auth.signInWithPassword({ email, password });
  if (passwordError || signedIn.user?.id !== userId) {
    return json({ error: "Wrong password" }, 403);
  }

  const { data: allowed, error: ownerError } = await service.rpc("can_delete_user", { p_user: userId });
  if (ownerError) {
    console.error(`delete-account: owner check failed: ${errorTag(ownerError)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  if (!allowed) {
    return json({ error: "You set up this instance: remove the other users first" }, 409);
  }

  const { data: sessions, error: sessionsError } = await service
    .from("bank_sessions").select("session_id").eq("user_id", userId);
  if (sessionsError) {
    console.error(`delete-account: sessions not read: ${errorTag(sessionsError)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  // Delete first: if it fails, the user keeps working banks. The session ids are already read.
  const { error } = await service.auth.admin.deleteUser(userId);
  if (error) {
    console.error(`delete-account failed: ${errorTag(error)}`);
    return json({ error: "Couldn't delete the account, please try again" }, 500);
  }
  // Links made before bank_sessions existed have no stored session: those expire on their own
  // (at most 180 days) and can be revoked from the bank's own app meanwhile.
  await closeSessions((sessions ?? []).map((s: { session_id: string }) => s.session_id)).catch((err) => {
    console.error(`delete-account: sessions not closed: ${errorTag(err)}`);
  });
  return json({ ok: true });
}));
