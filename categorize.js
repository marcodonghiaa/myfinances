require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { classifyWithGemini } = require('./gemini-classify');
const { fetchBatchForOneUser, walkNullRows } = require('./user-batch');
const { createStallGuard } = require('./stall-guard');
const { applyGroupedUpdates } = require('./batch-update');
const { CATEGORIES } = require('./categories');
const { buildCategorizePrompt } = require('./categorize-prompt');
const { applyRules, planRuleReapply, REAPPLY_SOURCES } = require('./rules');
const { fetchLearned, applyLearned, learnedUpdate, planRelearn } = require('./learned-categories');
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
  return classifyWithGemini({
    prompt: buildCategorizePrompt(rows),
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

async function applyLearnedMatches(matched) {
  await applyGroupedUpdates(
    supabase,
    matched.map(({ row, category }) => ({
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update: learnedUpdate(category),
      guardColumn: 'category',
    })),
  );
}

// Of `rows` (one user's), those whose merchant you categorized by hand before get that category.
async function learnFrom(rows) {
  if (rows.length === 0) return rows;
  const learned = await fetchLearned(supabase, rows[0].user_id, rows.map((r) => r.creditor_name));
  const { matched, unmatched } = applyLearned(rows, learned);
  if (matched.length > 0) {
    console.log(`Applying ${matched.length} category(ies) you set before for the same merchant...`);
    await applyLearnedMatches(matched);
  }
  return unmatched;
}

const RELEARN_DAYS = 120;

// Recent AI-categorized rows whose merchant you later categorized by hand take your category,
// so one correction fixes the merchant's other rows too. The update guards on category_source
// = 'ai', so a row you change in the meantime is never overwritten.
async function relearnAiRows() {
  const since = new Date(Date.now() - RELEARN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select('user_id, account_uid, entry_reference, creditor_name, category, category_source')
      .eq('category_source', 'ai')
      .gte('booking_date', since)
      .is('deleted_at', null)
      .order('account_uid')
      .order('entry_reference')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  let changed = 0;
  for (const userRows of Map.groupBy(rows, (r) => r.user_id).values()) {
    const learned = await fetchLearned(supabase, userRows[0].user_id, userRows.map((r) => r.creditor_name));
    const plan = planRelearn(userRows, learned);
    await applyGroupedUpdates(
      supabase,
      plan.map(({ row, category }) => ({
        account_uid: row.account_uid,
        entry_reference: row.entry_reference,
        update: learnedUpdate(category),
        guardColumn: 'category_source',
        guardIn: ['ai'],
      })),
    );
    changed += plan.length;
  }
  if (changed > 0) console.log(`Matched ${changed} AI category(ies) to ones you set for the same merchant.`);
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
  const filled = await walkNullRows(supabase, {
    select: 'user_id, account_uid, entry_reference, creditor_name, remittance_info',
    nullColumn: 'category',
    handlePage: async (rows) => {
      const { matched, unmatched } = applyRules(rows, rules);
      if (matched.length > 0) await applyRuleMatches(matched);
      // Categories you set by hand, one user at a time (the page can span users).
      let learned = 0;
      const byUser = Map.groupBy(unmatched, (r) => r.user_id);
      for (const userRows of byUser.values()) learned += userRows.length - (await learnFrom(userRows)).length;
      return matched.length + learned;
    },
  });
  console.log(`Applied rules or your past categories to ${filled} transaction(s).`);
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

    const { matched, unmatched: afterRules } = applyRules(rows, rules);

    if (matched.length > 0) {
      console.log(`Applying ${matched.length} rule match(es)...`);
      await applyRuleMatches(matched);
    }

    const unmatched = await learnFrom(afterRules);
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
    await relearnAiRows();
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
