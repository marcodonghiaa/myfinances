// Supabase Edge Function: post-sync
//
// What the launchd pipeline runs after the bank sync, moved into Supabase: merchant keys and
// alias dedupe for rows the sync didn't key (merchant-key-backfill.ts), categories for new
// rows (your rules, your past choices, then Gemini; port of categorize.js), then flow_type
// (spend / income / transfer) and refund pairs (classify-flow.js). Categories go first: a row
// that takes Transfer from your past choices also becomes a transfer. Then transaction types
// (classify-type.js) and Splitwise shares (categorize-splitwise.js). No bank calls, and every update only fills empty values (or moves AI
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
import { type Ask, classifyWithGemini } from "../_shared/gemini.ts";
import { classifyTypes } from "../_shared/classify-type.ts";
import { categorizeSplitwise } from "../_shared/splitwise.ts";
import { fillMerchantKeys } from "../_shared/merchant-key-backfill.ts";

const SECRET_KEYS = parseSecretKeys(Deno.env.get("SUPABASE_SECRET_KEYS"));
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SECRET_KEYS.default ?? Object.values(SECRET_KEYS)[0] ?? "",
  { global: { fetch: retryRejectedToken(fetch) } },
);

// Without GEMINI_API_KEY only your rules and past choices categorize; the rest waits for a key.
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const ask: Ask | null = GEMINI_API_KEY
  ? (prompt, resultKey, resultEnum) =>
    classifyWithGemini({ prompt, resultKey, resultEnum, apiKey: GEMINI_API_KEY, model: GEMINI_MODEL })
  : null;
const classify: Classify | null = ask
  ? (rows, categories) => ask(buildCategorizePrompt(rows, categories), "category", categories)
  : null;

// Stop starting new batches after this: a batch started just before can still take a Gemini
// call (25 s) and the flow step, all under the 150 s wall clock. What's left waits for the next run.
const BUDGET_MS = 100000;
// The AI steps stop earlier, so a big backlog never starves the cheap flow and refund steps.
const AI_BUDGET_MS = 70000;

Deno.serve(async (req) => {
  const started = Date.now();
  if (!hasSecretKey(req, SECRET_KEYS)) return Response.json({ error: "secret key required" }, { status: 401 });
  const timeLeft = () => Date.now() - started < BUDGET_MS;
  const aiTimeLeft = () => Date.now() - started < AI_BUDGET_MS;

  try {
    const keys = timeLeft() ? await fillMerchantKeys(supabase, timeLeft) : { keys: 0, aliases: 0 };
    const categories = await categorize(supabase, classify, aiTimeLeft);
    const types = await classifyTypes(supabase, ask, aiTimeLeft);
    const splitwise = await categorizeSplitwise(supabase, ask, aiTimeLeft);
    const flows = await classifyFlows(supabase, timeLeft);
    const refunds = timeLeft() ? await markRefunds(supabase) : 0;
    const result = { ...keys, ...categories, ...types, ...splitwise, flows: flows.total, refunds, stuck: flows.stuck, ms: Date.now() - started };
    console.log(`post-sync: ${JSON.stringify(result)}`);
    const failed = flows.stuck || categories.aiFailed || types.typeAiFailed || splitwise.splitwiseAiFailed;
    return Response.json(result, { status: failed ? 500 : 200 });
  } catch (err) {
    console.error(`post-sync failed: ${errorTag(err)}`);
    return Response.json({ error: "post-sync failed" }, { status: 500 });
  }
});
