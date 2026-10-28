// Supabase Edge Function: sync-bank
//
// P2 spike: the Node sync-networth + sync-transactions, for ONE account per call, so a
// slow bank can't push the whole run past the 150 s wall clock. Body: { "account_uid": "..." }.
// Only the service role may call it (pg_cron fans out one call per account): every call
// spends Enable Banking requests, and banks allow ~4 unattended calls a day per account.
// Never run it beside the launchd sync for the same reason.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { timingSafeEqual } from "jsr:@std/crypto@1/timing-safe-equal";
import { signEnableBankingJwt } from "../_shared/enable-banking.ts";
import {
  ACCOUNT_COLUMNS,
  errorTag,
  type SyncAccount,
  syncAccountBalance,
  syncAccountTransactions,
} from "../_shared/bank-sync.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE_KEY);

// All bank calls of one invocation share this budget, leaving time under the 150 s
// wall clock to save the cursor and snapshot. An aborted run keeps the old cursor.
const BANK_DEADLINE_MS = 120000;

const fail = (status: number, error: string) => Response.json({ error }, { status });

// verify_jwt lets any valid JWT through, the public anon key included: require the service role.
function isServiceRole(req: Request): boolean {
  const enc = new TextEncoder();
  const given = enc.encode(req.headers.get("Authorization") ?? "");
  const expected = enc.encode(`Bearer ${SERVICE_ROLE_KEY}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

Deno.serve(async (req) => {
  const started = Date.now();
  if (!isServiceRole(req)) return fail(401, "service role required");
  const body = await req.json().catch(() => null);
  const accountUid = body?.account_uid;
  if (typeof accountUid !== "string" || !accountUid) return fail(400, "account_uid required");

  const { data: account, error } = await supabase
    .from("accounts").select(ACCOUNT_COLUMNS).eq("uid", accountUid).maybeSingle<SyncAccount>();
  if (error) {
    console.error(`Failed to load account: ${errorTag(error)}`);
    return fail(500, "account lookup failed");
  }
  if (!account) return fail(404, "account not found");

  const cursorRead = await supabase
    .from("sync_cursors").select("last_synced").eq("account_uid", account.uid).maybeSingle();
  if (cursorRead.error) {
    // Without the cursor the sync would re-read 90 days: spend no bank call on a guess.
    console.error(`Failed to read sync cursor: ${errorTag(cursorRead.error)}`);
    return fail(500, "cursor lookup failed");
  }

  const deadline = AbortSignal.timeout(BANK_DEADLINE_MS);
  const deps = {
    fetch: (url: string | URL | Request, init: RequestInit = {}) => fetch(url, { ...init, signal: deadline }),
    supabase,
  };
  const token = await signEnableBankingJwt();
  const today = new Date().toISOString().slice(0, 10);

  // Balance first: it is the call that marks a consent the bank closed early (EXPIRED_SESSION).
  const balance = await syncAccountBalance(deps, token, account, today);
  let balanceSaved = false;
  if (balance.row) {
    // one snapshot per account per day: upsert avoids duplicates if run twice the same day
    const { error } = await supabase
      .from("net_worth_snapshots").upsert(balance.row, { onConflict: "account_uid,snapshot_date" });
    if (error) console.error(`Snapshot not saved: ${errorTag(error)}`);
    balanceSaved = !error;
  }

  // The bank just refused or failed this account: don't spend more of its daily calls on it.
  const tx = balance.ebFailed
    ? { upserted: 0, rejected: null, cursor: null }
    : await syncAccountTransactions(deps, token, account, cursorRead.data?.last_synced ?? null, today);
  if (tx.cursor) {
    const { error } = await supabase
      .from("sync_cursors").upsert({ account_uid: account.uid, last_synced: tx.cursor }, { onConflict: "account_uid" });
    if (error) console.error(`Sync cursor not saved: ${errorTag(error)}`);
  }

  const result = {
    upserted: tx.upserted,
    balance_saved: balanceSaved,
    rejected: balance.rejected ?? tx.rejected,
    renewed: balance.renewed,
    ms: Date.now() - started,
  };
  console.log(`sync-bank: ${JSON.stringify(result)}`);
  // 502 when the transactions did not sync, so pg_net's net._http_response shows the failure.
  return Response.json(result, { status: tx.cursor ? 200 : 502 });
});
