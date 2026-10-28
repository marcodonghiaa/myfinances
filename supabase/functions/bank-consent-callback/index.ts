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
import { EB_NO_ACCOUNTS, signEnableBankingJwt } from "../_shared/enable-banking.ts";
import { redirectOrigin } from "../_shared/origins.ts";
import { matchAccount, matchPatch, type StoredAccount } from "../_shared/account-match.ts";
import { bankLogo, type BankInfo } from "../_shared/bank-info.ts";
import { linkedParams } from "../_shared/linked-summary.ts";


const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

  // `state` is an opaque token from start-bank-consent, not a trusted user id
  // (Enable Banking never validates it -- see start-bank-consent's comment).
  // Resolve it against the single-use pending-consent row and delete it
  // immediately so it can't be replayed. Done first, for every outcome, because the row
  // also says which dashboard started the link and so where to send the browser back.
  let pending: { user_id: string; created_at: string; origin: string | null } | null = null;
  let pendingError: unknown = null;
  if (state) {
    const res = await supabase
      .from("pending_bank_consents")
      .delete()
      .eq("id", state)
      .select("user_id, created_at, origin")
      .maybeSingle();
    pending = res.data;
    pendingError = res.error;
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

  // Land back in the real app instead of a bare Edge Function page -- the app
  // reads bank_linked/bank_link_error off /accounts and shows a proper toast.
  const redirectToApp = (params: Record<string, string>): Response => {
    const target = new URL(`${appUrl}/accounts`);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  };

  // Log the real reason server-side; the redirect URL (and the toast it feeds) only
  // gets a generic message so database or upstream error text never reaches the browser.
  const failLink = (detail: string): Response => {
    console.error("bank-consent-callback failed:", detail);
    return redirectToApp({ bank_link_error: "Couldn't link the bank, please try again" });
  };

  if (errorParam) {
    // errorParam comes from a public GET, so it is logged, not echoed into the app.
    console.error("bank declined consent:", errorParam);
    return redirectToApp({ bank_link_error: "The bank did not approve the connection" });
  }
  if (!code || !state) {
    return redirectToApp({ bank_link_error: "Missing code or state" });
  }
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return failLink(data.message ?? `Enable Banking error ${res.status}`);
    }

    const accounts = (data.accounts ?? []) as Array<EnableBankingAccount>;
    if (accounts.length === 0) return redirectToApp({ bank_link_error: EB_NO_ACCOUNTS });
    const consentValidUntil = data.access?.valid_until ?? null;

    // The bank itself (name, country), not the holder name EB returns as the account name.
    // Logo comes from /aspsps; best-effort, a failed lookup only leaves the logo null.
    const aspsp = (data.aspsp ?? null) as { name?: string | null; country?: string | null } | null;
    const bankName = aspsp?.name ?? null;
    const bankCountry = aspsp?.country ?? null;
    let logo: string | null = null;
    if (bankName && bankCountry) {
      try {
        const aspspRes = await fetch(
          `https://api.enablebanking.com/aspsps?country=${encodeURIComponent(bankCountry)}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) },
        );
        if (aspspRes.ok) logo = bankLogo((await aspspRes.json()).aspsps ?? null, bankName);
      } catch {
        // best-effort, logo stays null
      }
    }
    const bank: BankInfo = { bank_name: bankName, bank_country: bankCountry, bank_logo: logo };
    const savedRows: Array<{ uid: string; ebUid: string; label: string | null; currency: string }> = [];

    // uid is the PK (transactions, snapshots and sync_cursors reference it), so an existing row's uid
    // never changes. eb_account_uid follows the session: EB account ids die with their session, so a
    // renewal stores the new one there.
    // Match on identification_hash (IBAN + currency, unique per Revolut pocket), then IBAN + currency.
    const { data: storedRows, error: storedError } = await supabase
      .from("accounts")
      .select("uid, iban, currency, identification_hash")
      .eq("user_id", userId);
    if (storedError) return failLink(storedError.message);
    let stored: StoredAccount[] = storedRows ?? [];

    for (const a of accounts) {
      const iban = a.account_id?.iban ?? null;
      const identificationHash = a.identification_hash ?? null;
      const label = a.name ?? null;

      let uid = matchAccount(stored, { iban, currency: a.currency, identification_hash: identificationHash });

      if (!uid) {
        const { error } = await supabase.from("accounts").insert({
          uid: a.uid,
          eb_account_uid: a.uid,
          currency: a.currency,
          label,
          iban,
          identification_hash: identificationHash,
          user_id: userId,
          consent_valid_until: consentValidUntil,
          ...bank,
        });
        if (!error) {
          stored = [...stored, { uid: a.uid, iban, currency: a.currency, identification_hash: identificationHash }];
          savedRows.push({ uid: a.uid, ebUid: a.uid, label, currency: a.currency });
          continue;
        }
        // A concurrent callback inserted the same pocket first (unique user_id + identification_hash).
        if (error.code !== "23505" || !identificationHash) return failLink(error.message);
        const { data: raced, error: racedError } = await supabase
          .from("accounts")
          .select("uid, iban, currency, identification_hash")
          .eq("user_id", userId)
          .eq("identification_hash", identificationHash)
          .maybeSingle();
        if (racedError || !raced) return failLink(racedError?.message ?? "conflicting account row not found");
        const racedRow: StoredAccount = raced;
        stored = [...stored, racedRow];
        uid = racedRow.uid;
      }

      const patch = matchPatch(
        { iban, currency: a.currency, identification_hash: identificationHash, label },
        a.uid,
        consentValidUntil,
        bank,
      );
      const { error } = await supabase
        .from("accounts")
        .update(patch)
        .eq("uid", uid);
      if (error) {
        return failLink(error.message);
      }
      stored = stored.map((s) =>
        s.uid === uid
          ? { ...s, iban: iban ?? s.iban, currency: a.currency, identification_hash: identificationHash ?? s.identification_hash }
          : s
      );
      savedRows.push({ uid, ebUid: a.uid, label, currency: a.currency });
    }

    // Fetch an immediate balance for each linked account instead of leaving
    // it invisible until the next scheduled sync (up to 6 hours away) --
    // same /accounts/{id}/balances call sync-networth.js makes on its
    // batch schedule, just run once here for the accounts that just linked.
    // Best-effort: a failure here doesn't fail the link, the batch job
    // catches it up at the next sync regardless.
    const today = new Date().toISOString().slice(0, 10);
    for (const row of savedRows) {
      try {
        const balRes = await fetch(
          `https://api.enablebanking.com/accounts/${row.ebUid}/balances`,
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

    return redirectToApp(linkedParams(savedRows.length, bank.bank_name, savedRows.map((r) => r.currency)));
  } catch (err) {
    return failLink((err as Error).message);
  }
});
