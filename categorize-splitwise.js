require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { classifyWithGemini } = require('./gemini-classify');
const { fetchBatchForOneUser } = require('./user-batch');
const { createStallGuard } = require('./stall-guard');
const { SPLITWISE_CATEGORIES, buildPrompt, planUpdates } = require('./splitwise-categories');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const BATCH_SIZE = 40;

function fetchUncategorized(excludeUserIds) {
  return fetchBatchForOneUser(supabase, {
    table: 'splitwise_expenses',
    select: 'id, description',
    nullColumn: 'category',
    limit: BATCH_SIZE,
    excludeUserIds,
  });
}

// Only fills empty categories: a choice made in the import screen (including "Others")
// is never overwritten, because every statement is guarded on category being null.
async function applyPlan(plan) {
  const groups = new Map();
  for (const { id, user_id, category } of plan) {
    const key = `${user_id}|${category}`;
    if (!groups.has(key)) groups.set(key, { user_id, category, ids: [] });
    groups.get(key).ids.push(id);
  }
  for (const { user_id, category, ids } of groups.values()) {
    const { error } = await supabase
      .from('splitwise_expenses')
      .update({ category })
      .eq('user_id', user_id)
      .in('id', ids)
      .is('category', null);
    if (error) console.error(`Failed to categorize ${ids.length} Splitwise share(s):`, error.message);
  }
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is not set: Splitwise shares without a category stay uncategorized.');
    return;
  }

  let total = 0;
  const stalls = createStallGuard();
  while (true) {
    const rows = await fetchUncategorized(stalls.stuckUserIds);
    if (rows.length === 0) break;

    // The stall guard keys on account_uid + entry_reference; a share has neither.
    if (stalls.isStalled(rows.map((r) => ({ user_id: r.user_id, account_uid: 'splitwise', entry_reference: r.id })))) {
      console.warn(`No progress for user ${rows[0].user_id}, skipping them for this run.`);
      continue;
    }

    console.log(`Categorizing ${rows.length} Splitwise share(s) via AI...`);
    const results = await classifyWithGemini({
      prompt: buildPrompt(rows),
      resultKey: 'category',
      resultEnum: SPLITWISE_CATEGORIES,
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
    });
    await applyPlan(planUpdates(results, rows));
    total += rows.length;
  }

  console.log(`Done. Looked at ${total} Splitwise share(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
