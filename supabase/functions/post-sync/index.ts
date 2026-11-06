// Supabase Edge Function: post-sync
//
// What the launchd pipeline runs after the bank sync, moved into Supabase: categories for new
// rows (your rules, your past choices, then Gemini; port of categorize.js), then flow_type
// (spend / income / transfer) and refund pairs (classify-flow.js). Categories go first: a row
// that takes Transfer from your past choices also becomes a transfer. Transaction types and
// Splitwise come next. No bank calls, and every update only fills empty values (or moves AI
// rows to your choice, spend/income to refunded), so it is safe to run beside the launchd sync;
// the only cost is that both may send the same new rows to Gemini once.
// Callers send a project secret key on the apikey header, like sync-bank.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { hasSecretKey, parseSecretKeys } from "../_shared/secret-key.ts";
import { retryRejectedToken } from "../_shared/postgrest-retry.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { classifyFlows, markRefunds } from "../_shared/flow.ts";
import { categorize, type Classify } from "../_shared/categorize.ts";
import { buildCategorizePrompt } from "../_shared/categorize-prompt.ts";
import { classifyWithGemini } from "../_shared/gemini.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// Without GEMINI_API_KEY only your rules and past choices categorize; the rest waits for a key.
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const classify: Classify | null = GEMINI_API_KEY
  ? (rows, categories) =>
    classifyWithGemini({
      prompt: buildCategorizePrompt(rows, categories),
      resultKey: "category",
      resultEnum: categories,
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
    })
  : null;

// Stop starting new batches after this: a batch started just before can still take a Gemini
// call (25 s) and the flow step, all under the 150 s wall clock. What's left waits for the next run.
const BUDGET_MS = 100000;

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const timeLeft = () => Date.now() - started < BUDGET_MS;

  try {
    const categories = await categorize(supabase, classify, timeLeft);
    const flows = await classifyFlows(supabase, timeLeft);
    const refunds = timeLeft() ? await markRefunds(supabase) : 0;
    const result = { ...categories, flows: flows.total, refunds, stuck: flows.stuck, ms: Date.now() - started };
    console.log(`post-sync: ${JSON.stringify(result)}`);
    return Response.json(result, { status: flows.stuck || categories.aiFailed ? 500 : 200 });
  } catch (err) {
    console.error(`post-sync failed: ${errorTag(err)}`);
    return Response.json({ error: "post-sync failed" }, { status: 500 });
  }
});
