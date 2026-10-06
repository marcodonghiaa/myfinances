// Supabase Edge Function: bank-consent-callback
//
// Third step of self-serve bank linking. Enable Banking redirects the
// user's browser here after they approve consent, with ?code=&state=.
// Exchanges the code, then upserts the discovered accounts into the
// `accounts` table for that user.
//
// No verify_jwt here: the bank's redirect is a plain browser GET with no
// Authorization header. `state` is a single-use opaque token minted by
// start-bank-consent (a row id in pending_bank_consents), NOT a trusted
// user id directly -- Enable Banking never validates state itself, so a
// bare user id there would let anyone who completes their OWN consent
// hand-edit state to a victim's id before hitting this callback. The real
// user id only comes from looking up and deleting that row here.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { signEnableBankingJwt } from "../_shared/enable-banking.ts";


const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const APP_URL = Deno.env.get("FRONTEND_URL")!;

// Land back in the real app instead of a bare Edge Function page -- the app
// reads bank_linked/bank_link_error off /accounts and shows a proper toast.
function redirectToApp(params: Record<string, string>): Response {
  const url = new URL(`${APP_URL}/accounts`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

interface EnableBankingAccount {
  uid: string;
  currency: string;
  name?: string | null;
  account_id?: { iban?: string | null } | null;
  identification_hash?: string | null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return redirectToApp({ bank_link_error: errorParam });
  }
  if (!code || !state) {
    return redirectToApp({ bank_link_error: "Missing code or state" });
  }

  // `state` is an opaque token from start-bank-consent, not a trusted user id
  // (Enable Banking never validates it -- see start-bank-consent's comment).
  // Resolve it against the single-use pending-consent row and delete it
  // immediately so it can't be replayed.
  const { data: pending, error: pendingError } = await supabase
    .from("pending_bank_consents")
    .delete()
    .eq("id", state)
    .select("user_id, created_at")
    .maybeSingle();
  if (pendingError || !pending) {
    return redirectToApp({ bank_link_error: "Invalid or expired consent request" });
  }
  if (Date.now() - new Date(pending.created_at).getTime() > 15 * 60 * 1000) {
    return redirectToApp({ bank_link_error: "Consent request expired, please try again" });
  }
  const userId = pending.user_id;

  try {
    const token = await signEnableBankingJwt();
    const res = await fetch("https://api.enablebanking.com/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      return redirectToApp({ bank_link_error: data.message ?? "Enable Banking error" });
    }

    const accounts = (data.accounts ?? []) as Array<EnableBankingAccount>;
    const consentValidUntil = data.access?.valid_until ?? null;
    const savedRows: Array<{ uid: string; label: string | null; currency: string }> = [];

    // Enable Banking issues a new uid per consent session, even for the same
    // physical account -- re-linking would otherwise create a duplicate row.
    // uid is the PK (transactions.account_uid references it), so it must
    // never change on an existing row. Dedup by IBAN when present; IBAN-less
    // banks (Revolut, confirmed via live test) fall back to
    // identification_hash, which Enable Banking guarantees on every account
    // regardless of IBAN and keeps stable across separate consent sessions
    // for the same physical account. Only truly falls back to inserting a
    // new row when neither matches an existing one.
    for (const a of accounts) {
      const iban = a.account_id?.iban ?? null;
      const identificationHash = a.identification_hash ?? null;
      const label = a.name ?? null;

      let existingUid: string | null = null;
      if (iban) {
        const { data: existing, error } = await supabase
          .from("accounts")
          .select("uid")
          .eq("user_id", userId)
          .eq("iban", iban)
          .maybeSingle();
        if (error) return redirectToApp({ bank_link_error: error.message });
        existingUid = existing?.uid ?? null;
      }
      if (!existingUid && identificationHash) {
        const { data: existing, error } = await supabase
          .from("accounts")
          .select("uid")
          .eq("user_id", userId)
          .eq("identification_hash", identificationHash)
          .maybeSingle();
        if (error) return redirectToApp({ bank_link_error: error.message });
        existingUid = existing?.uid ?? null;
      }

      if (existingUid) {
        const patch: Record<string, unknown> = {
          consent_valid_until: consentValidUntil,
          currency: a.currency,
        };
        if (label !== null) patch.label = label;
        if (identificationHash !== null) patch.identification_hash = identificationHash;
        const { error } = await supabase
          .from("accounts")
          .update(patch)
          .eq("uid", existingUid);
        if (error) {
          return redirectToApp({ bank_link_error: error.message });
        }
        savedRows.push({ uid: existingUid, label, currency: a.currency });
      } else {
        const { error } = await supabase.from("accounts").insert({
          uid: a.uid,
          currency: a.currency,
          label,
          iban,
          identification_hash: identificationHash,
          user_id: userId,
          consent_valid_until: consentValidUntil,
        });
        if (error) {
          return redirectToApp({ bank_link_error: error.message });
        }
        savedRows.push({ uid: a.uid, label, currency: a.currency });
      }
    }

    // Fetch an immediate balance for each linked account instead of leaving
    // it invisible until the next scheduled sync (up to 6 hours away) --
    // same /accounts/{uid}/balances call sync-networth.js makes on its
    // batch schedule, just run once here for the accounts that just linked.
    // Best-effort: a failure here doesn't fail the link, the batch job
    // catches it up at the next sync regardless.
    const today = new Date().toISOString().slice(0, 10);
    for (const row of savedRows) {
      try {
        const balRes = await fetch(
          `https://api.enablebanking.com/accounts/${row.uid}/balances`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!balRes.ok) continue;
        const balData = await balRes.json();
        const balance = balData.balances?.[0];
        if (!balance) continue;
        await supabase.from("net_worth_snapshots").upsert(
          {
            account_uid: row.uid,
            user_id: userId,
            currency: balance.balance_amount.currency,
            amount: parseFloat(balance.balance_amount.amount),
            snapshot_date: today,
          },
          { onConflict: "account_uid,snapshot_date" },
        );
      } catch {
        // best-effort, batch sync will catch up
      }
    }

    return redirectToApp({ bank_linked: String(savedRows.length) });
  } catch (err) {
    return redirectToApp({ bank_link_error: (err as Error).message });
  }
});
