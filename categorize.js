require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { classifyWithGemini, UNTRUSTED_TEXT_NOTE } = require('./gemini-classify');
const { fetchBatchForOneUser, walkNullRows } = require('./user-batch');
const { createStallGuard } = require('./stall-guard');
const { applyGroupedUpdates } = require('./batch-update');
const { CATEGORIES, guideFor } = require('./categories');
const { applyRules, planRuleReapply, REAPPLY_SOURCES } = require('./rules');
const { errorTag } = require('./log-safe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const BATCH_SIZE = 40;

function fetchUncategorized(excludeUserIds) {
  return fetchBatchForOneUser(supabase, {
    select: 'entry_reference, account_uid, creditor_name, debtor_name, remittance_info, amount, currency, credit_debit_indicator',
    nullColumn: 'category',
    limit: BATCH_SIZE,
    excludeUserIds,
  });
}

async function fetchRules() {
  const { data, error } = await supabase
    .from('category_rules')
    .select('user_id, match_field, match_text, set_category, set_transaction_type')
    .not('set_category', 'is', null)
    .order('priority', { ascending: true });
  if (error) throw error;
  return data;
}

async function classifyBatch(rows) {
  const prompt = `You are categorizing personal bank transactions into exactly one of these categories: ${CATEGORIES.join(', ')}.

Category guide:
${guideFor(CATEGORIES)}

Base your judgement on creditor_name and remittance_info — merchant/reference text that may be messy, abbreviated, or in a foreign language. This matters especially for P2P/bank transfers to a person: creditor_name alone (a person's name) tells you nothing, but remittance_info often does — e.g. a transfer to a friend with remittance_info mentioning "spotify" or "netflix" should be categorized by that actual purpose (Entertainment), not filed under Transfer just because the payment method was a person-to-person transfer. Only use Transfer when nothing in remittance_info indicates a real purpose.

${UNTRUSTED_TEXT_NOTE}

Transactions (JSON array):
${JSON.stringify(rows.map((r) => ({
  entry_reference: r.entry_reference,
  creditor_name: r.creditor_name,
  remittance_info: r.remittance_info,
  amount: r.amount,
  currency: r.currency,
  direction: r.credit_debit_indicator,
})), null, 2)}

Return a JSON array of {"entry_reference": string, "category": string} for every transaction above, same order, one entry each. category must be exactly one of the allowed categories.`;

  return classifyWithGemini({
    prompt,
    resultKey: 'category',
    resultEnum: CATEGORIES,
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
  });
}

async function applyCategories(results, rows) {
  const accountByRef = new Map(rows.map((r) => [r.entry_reference, r.account_uid]));
  const items = [];
  let invalid = 0;
  for (const { entry_reference, category } of results) {
    const account_uid = accountByRef.get(entry_reference);
    if (!account_uid) continue; // model echoed a reference we never sent
    if (!CATEGORIES.includes(category)) {
      invalid++;
      continue;
    }
    items.push({ account_uid, entry_reference, update: { category, category_source: 'ai' }, guardColumn: 'category' });
  }
  if (invalid > 0) console.warn(`Skipping ${invalid} invalid category result(s).`);
  await applyGroupedUpdates(supabase, items);
}

async function applyRuleMatches(matched) {
  await applyGroupedUpdates(
    supabase,
    matched.map(({ row, rule }) => {
      const update = { category: rule.set_category, category_source: 'rule' };
      if (rule.set_transaction_type) update.transaction_type = rule.set_transaction_type;
      return { account_uid: row.account_uid, entry_reference: row.entry_reference, update, guardColumn: 'category' };
    }),
  );
}


const REAPPLY_PAGE_SIZE = 1000;

// Re-runs the current rules over rows the AI or an earlier rule categorized. Rows a user
// edited by hand (category_source 'manual') or that predate provenance ('legacy') are
// never selected, and the update statement guards on the same column.
async function reapplyRules() {
  const rules = await fetchRules();
  if (rules.length === 0) {
    console.log('No categorization rules to apply.');
    return;
  }
  let changed = 0;
  for (let from = 0; ; from += REAPPLY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('user_id, account_uid, entry_reference, creditor_name, remittance_info, category, category_source')
      .in('category_source', REAPPLY_SOURCES)
      .order('account_uid')
      .order('entry_reference')
      .range(from, from + REAPPLY_PAGE_SIZE - 1);
    if (error) throw error;
    const items = planRuleReapply(data, rules);
    await applyGroupedUpdates(supabase, items);
    changed += items.length;
    if (data.length < REAPPLY_PAGE_SIZE) break;
  }
  console.log(`Done. Re-applied rules to ${changed} transaction(s).`);
}

// Rules alone, over every uncategorized row: used without a Gemini key, or after the AI
// fails, so your rules never depend on the AI being available.
async function applyRulesOnly(rules) {
  if (rules.length === 0) return;
  const filled = await walkNullRows(supabase, {
    select: 'user_id, account_uid, entry_reference, creditor_name, remittance_info',
    nullColumn: 'category',
    handlePage: async (rows) => {
      const { matched } = applyRules(rows, rules);
      if (matched.length > 0) await applyRuleMatches(matched);
      return matched.length;
    },
  });
  console.log(`Applied rules to ${filled} transaction(s).`);
}

async function categorizeWithAi(rules) {
  let totalCategorized = 0;
  const stalls = createStallGuard();
  while (true) {
    const rows = await fetchUncategorized(stalls.stuckUserIds);
    if (rows.length === 0) break;

    if (stalls.isStalled(rows)) {
      console.warn('No progress for one user, skipping them for this run.');
      continue;
    }

    const { matched, unmatched } = applyRules(rows, rules);

    if (matched.length > 0) {
      console.log(`Applying ${matched.length} rule match(es)...`);
      await applyRuleMatches(matched);
    }

    if (unmatched.length > 0) {
      console.log(`Categorizing ${unmatched.length} transaction(s) via AI...`);
      const results = await classifyBatch(unmatched);
      await applyCategories(results, unmatched);
    }

    totalCategorized += rows.length;
  }

  console.log(`Done. Categorized ${totalCategorized} transaction(s).`);
}

async function main() {
  if (process.argv.includes('--reapply-rules')) return reapplyRules();

  const rules = await fetchRules();
  if (rules.length > 0) console.log(`Loaded ${rules.length} categorization rule(s).`);

  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is not set: applying your rules only. Add a key to .env to categorize the rest with AI.');
    return applyRulesOnly(rules);
  }
  try {
    await categorizeWithAi(rules);
  } catch (err) {
    console.error(`AI categorization failed, applying your rules only: ${errorTag(err)}`);
    await applyRulesOnly(rules);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Failed: ${errorTag(err)}`);
  process.exit(1);
});
