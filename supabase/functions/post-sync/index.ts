// Supabase Edge Function: post-sync
//
// What the launchd pipeline runs after the bank sync, moved into Supabase. For now: flow_type
// (spend / income / transfer) for new rows, then refund pairs (port of classify-flow.js).
// Categories and types (Gemini) come next. No bank calls, and every update only fills empty
// values or moves spend/income to refunded, so it is safe to run beside the launchd sync.
// Callers send a project secret key on the apikey header, like sync-bank.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { classifyFlows, markRefunds } from "../_shared/flow.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// Stop starting new batches after this, leaving time under the 150 s wall clock to finish;
// what's left waits for the next run.
const BUDGET_MS = 120000;

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const timeLeft = () => Date.now() - started < BUDGET_MS;

  try {
    const flows = await classifyFlows(supabase, timeLeft);
    const refunds = timeLeft() ? await markRefunds(supabase) : 0;
    const result = { flows: flows.total, refunds, stuck: flows.stuck, ms: Date.now() - started };
    console.log(`post-sync: ${JSON.stringify(result)}`);
    return Response.json(result, { status: flows.stuck ? 500 : 200 });
  } catch (err) {
    console.error(`post-sync failed: ${errorTag(err)}`);
    return Response.json({ error: "post-sync failed" }, { status: 500 });
  }
});
