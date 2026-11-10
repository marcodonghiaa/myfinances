// The second half of bank linking, shared by complete-bank-consent: exchanges Enable Banking's
// one-time code for a session, then stores the accounts it shares under `userId`. The caller must
// already have proved that `userId` is the signed-in user who started this link.

import { EB_NO_ACCOUNTS, signEnableBankingJwt } from "./enable-banking.ts";
import { errorTag } from "./log-safe.ts";
import { accountType, matchAccount, matchPatch, type StoredAccount } from "./account-match.ts";
import { bankLogo, type BankInfo } from "./bank-info.ts";
import { linkedParams } from "./linked-summary.ts";
import { latestFxRows } from "./fx-rates.ts";

export const LINK_FAILED = "Couldn't link the bank, please try again";

interface EnableBankingAccount {
  uid: string;
  currency: string;
  name?: string | null;
  account_id?: { iban?: string | null } | null;
  identification_hash?: string | null;
  cash_account_type?: string | null;
}

export type LinkResult = { params: Record<string, string>; newAccountUids: string[] } | { error: string };

// deno-lint-ignore no-explicit-any
export async function linkAccounts(supabase: any, userId: string, code: string): Promise<LinkResult> {
  // Log the real reason server-side; the reply only gets a generic message.
  const fail = (err: unknown): { error: string } => {
    console.error(`bank link failed: ${errorTag(err)}`);
    return { error: LINK_FAILED };
  };

  try {
    const token = await signEnableBankingJwt();
    const res = await fetch("https://api.enablebanking.com/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return fail({ status: res.status });
    }

    const accounts = (data.accounts ?? []) as Array<EnableBankingAccount>;
    if (accounts.length === 0) return { error: EB_NO_ACCOUNTS };
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

    // Kept so the session can be closed at Enable Banking when the user deletes their account.
    // Best effort: a failed write only means that session is left to expire on its own.
    if (typeof data.session_id === "string") {
      const { error: sessionError } = await supabase
        .from("bank_sessions")
        .upsert({ session_id: data.session_id, user_id: userId, bank_name: bankName }, { onConflict: "session_id" });
      if (sessionError) console.error(`bank session not stored: ${errorTag(sessionError)}`);
    }
    const savedRows: Array<{ uid: string; ebUid: string; label: string | null; currency: string }> = [];

    // uid is the PK (transactions, snapshots and sync_cursors reference it), so an existing row's uid
    // never changes. eb_account_uid follows the session: EB account ids die with their session, so a
    // renewal stores the new one there.
    // Match on identification_hash (IBAN + currency, unique per Revolut pocket), then IBAN + currency.
    const { data: storedRows, error: storedError } = await supabase
      .from("accounts")
      .select("uid, iban, currency, identification_hash, account_type")
      .eq("user_id", userId);
    if (storedError) return fail(storedError);
    let stored: StoredAccount[] = storedRows ?? [];

    const newUids: string[] = []; // first-synced right away; relinked ones wait for the cron
    for (const a of accounts) {
      const iban = a.account_id?.iban ?? null;
      const identificationHash = a.identification_hash ?? null;
      const label = a.name ?? null;
      const type = accountType(a.cash_account_type);

      let uid = matchAccount(stored, { iban, currency: a.currency, identification_hash: identificationHash });

      if (!uid) {
        const { error } = await supabase.from("accounts").insert({
          uid: a.uid,
          eb_account_uid: a.uid,
          currency: a.currency,
          label,
          iban,
          identification_hash: identificationHash,
          account_type: type,
          user_id: userId,
          consent_valid_until: consentValidUntil,
          ...bank,
        });
        if (!error) {
          stored = [...stored, { uid: a.uid, iban, currency: a.currency, identification_hash: identificationHash, account_type: type }];
          savedRows.push({ uid: a.uid, ebUid: a.uid, label, currency: a.currency });
          newUids.push(a.uid);
          continue;
        }
        // A concurrent callback inserted the same pocket first (unique user_id + identification_hash).
        if (error.code !== "23505" || !identificationHash) return fail(error);
        const { data: raced, error: racedError } = await supabase
          .from("accounts")
          .select("uid, iban, currency, identification_hash, account_type")
          .eq("user_id", userId)
          .eq("identification_hash", identificationHash)
          .maybeSingle();
        if (racedError || !raced) return fail(racedError ?? { name: "RacedRowMissing" });
        const racedRow: StoredAccount = raced;
        stored = [...stored, racedRow];
        uid = racedRow.uid;
      }

      // The type only fills a gap: a type the user corrected stays.
      const storedType = stored.find((s) => s.uid === uid)?.account_type ?? null;
      const patch = {
        ...matchPatch({ iban, currency: a.currency, identification_hash: identificationHash, label }, a.uid, consentValidUntil, bank),
        ...(storedType === null && type !== null && { account_type: type }),
      };
      const { error } = await supabase
        .from("accounts")
        .update(patch)
        .eq("uid", uid);
      if (error) {
        return fail(error);
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
    // New accounts skip it: complete-bank-consent starts their first sync (balance included)
    // right away, and a second balance call would spend one of the bank's few daily calls.
    const today = new Date().toISOString().slice(0, 10);
    for (const row of savedRows.filter((r) => !newUids.includes(r.uid))) {
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

    // A fresh instance has no fx_rates until the first sync, and v_net_worth_eur counts a currency
    // with no rate as 0. Seed the latest rates now. Best-effort, fx-sync.js keeps them current.
    try {
      const rows = await latestFxRows(savedRows.map((r) => r.currency));
      if (rows.length > 0) {
        const { error } = await supabase.from("fx_rates").upsert(rows, { onConflict: "date,currency" });
        if (error) throw error;
      }
    } catch (err) {
      console.error(`fx seed failed: ${errorTag(err)}`);
    }

    return {
      params: linkedParams(savedRows.length, bank.bank_name, savedRows.map((r) => r.currency)),
      newAccountUids: newUids,
    };
  } catch (err) {
    return fail(err);
  }
}
