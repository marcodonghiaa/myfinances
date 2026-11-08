// Supabase Edge Function: detect-recurring
//
// Finds recurring charges (subscription radar) for every user and stores them in
// recurring_streams through upsert_detected_streams. No bank calls; safe to run any time.
// Callers send a project secret key on the apikey header, like post-sync.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { runDetection } from "../_shared/detect-recurring-job.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// Stop starting new users after this, well under the 150 s wall clock. What's left waits for the next run.
const BUDGET_MS = 100000;

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());
    const result = {
      ...await runDetection(supabase, (fn, args) => supabase.rpc(fn, args), today, () => Date.now() - started < BUDGET_MS),
      ms: Date.now() - started,
    };
    console.log(`detect-recurring: ${JSON.stringify(result)}`);
    return Response.json(result, { status: result.failed ? 500 : 200 });
  } catch (err) {
    console.error(`detect-recurring failed: ${errorTag(err)}`);
    return Response.json({ error: "detect-recurring failed" }, { status: 500 });
  }
});
