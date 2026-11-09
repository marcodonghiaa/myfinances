// Supabase Edge Function: bank-consent-callback
//
// Third step of self-serve bank linking. Enable Banking redirects the user's browser here after
// they approve consent, with ?code=&state=. This address is registered in every self-hoster's
// Enable Banking app, so it never moves.
//
// It links nothing itself. The bank's redirect is a plain browser GET with no sign-in, so this
// function can't tell who is holding the browser: storing the accounts under whoever *started*
// the link (the pending row's user) let a user send someone else their own consent URL and
// collect that person's accounts. So it only checks the request and sends the browser on to the
// dashboard with the code; the dashboard, signed in, calls complete-bank-consent, which links
// the accounts only when the signed-in user is the one who started this link.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { redirectOrigin } from "../_shared/origins.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CONSENT_WINDOW_MS = 15 * 60 * 1000;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // The pending row says which dashboard started the link, and so where to send the browser back.
  // Read, not deleted: complete-bank-consent consumes it once the signed-in user is known.
  let pending: { created_at: string; origin: string | null } | null = null;
  if (state) {
    const res = await supabase
      .from("pending_bank_consents")
      .select("created_at, origin")
      .eq("id", state)
      .maybeSingle();
    pending = res.data;
  }

  // Only ever an origin the owner registered (or the legacy FRONTEND_URL secret), chosen server-side:
  // nothing in this request's URL decides where the browser goes.
  const appUrl = await redirectOrigin(pending?.origin ?? null);
  if (!appUrl) {
    return new Response(
      "Your dashboard's address isn't known yet. Open your dashboard, sign in once, then link the bank again.",
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const redirectToApp = (params: Record<string, string>): Response => {
    const target = new URL(`${appUrl}/accounts`);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  };

  if (errorParam) {
    // errorParam comes from a public GET: only a plain error code is logged, never free text.
    console.error(`bank declined consent: ${/^[a-z_]{1,40}$/.test(errorParam) ? errorParam : "other"}`);
    return redirectToApp({ bank_link_error: "The bank did not approve the connection" });
  }
  if (!code || !state) {
    return redirectToApp({ bank_link_error: "Missing code or state" });
  }
  if (!pending) {
    return redirectToApp({ bank_link_error: "Invalid or expired consent request" });
  }
  if (Date.now() - new Date(pending.created_at).getTime() > CONSENT_WINDOW_MS) {
    return redirectToApp({ bank_link_error: "Consent request expired, please try again" });
  }
  // complete-bank-consent spends the one-time code within seconds, or closes it when the link is
  // refused; the dashboard drops it from the address bar straight away. Until then it is a secret:
  // it is not tied to this state, so whoever holds it could pair it with a link of their own.
  // bank_link_error is for dashboards older than this backend, which ignore bank_code: they show
  // it and clear the address bar. Current dashboards finish the link and ignore it.
  return redirectToApp({
    bank_code: code,
    bank_state: state,
    bank_link_error: "Update your dashboard to finish linking this bank",
  });
});
