// Deno port of categorize.js (minus --reapply-rules, which stays a local command). For each new
// row: your rules first, then the category you set by hand for the same merchant, then the AI;
// afterwards AI rows take your later hand-set choice for their merchant. Without an AI (no key,
// or it fails) your rules and past choices still apply.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { CATEGORIES, categoriesFor } from "./categories.ts";
import { applyLearned, fetchLearned, learnedUpdate, planRelearn } from "./learned-categories.ts";
import { errorTag } from "./log-safe.ts";
import { applyRules, type Rule } from "./rules.ts";
import { createStallGuard } from "./stall-guard.ts";
import { fetchBatchForOneUser, walkNullRows } from "./user-batch.ts";
import type { CategorizeRow } from "./categorize-prompt.ts";

const BATCH_SIZE = 40;
const RELEARN_DAYS = 120;
const PAGE = 1000;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
/** Sends one user's rows to the AI and returns [{entry_reference, category}]. */
export type Classify = (rows: CategorizeRow[], categories: string[]) => Promise<Array<Record<string, string>>>;

async function fetchRules(db: Db): Promise<Rule[]> {
  const { data, error } = await db
    .from("category_rules")
    .select("user_id, match_field, match_text, set_category, set_transaction_type")
    .not("set_category", "is", null)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true }); // every rule has priority 100: oldest first, as listed
  if (error) throw error;
  return data;
}

// The user's own list (see user_categories); the built-in list if it can't be read.
async function fetchUserCategories(db: Db, userId: string): Promise<string[]> {
  const { data, error } = await db.from("user_categories").select("name, hidden").eq("user_id", userId);
  if (error) {
    if (!["42P01", "PGRST205"].includes(error.code)) console.warn(`Using the built-in categories: ${errorTag(error)}`);
    return CATEGORIES;
  }
  return categoriesFor(data);
}

const applyRuleMatches = (db: Db, matched: Array<{ row: Row; rule: Rule }>) =>
  applyGroupedUpdates(
    db,
    matched.map(({ row, rule }) => {
      const update: Record<string, unknown> = { category: rule.set_category, category_source: "rule" };
      if (rule.set_transaction_type) update.transaction_type = rule.set_transaction_type;
      return { account_uid: row.account_uid, entry_reference: row.entry_reference, update, guardColumn: "category" };
    }),
  );

// Of `rows` (one user's), those whose merchant you categorized by hand before get that category.
async function learnFrom(db: Db, rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const learned = await fetchLearned(db, rows[0].user_id, rows.map((r) => r.creditor_name));
  const { matched, unmatched } = applyLearned(rows, learned);
  await applyGroupedUpdates(
    db,
    matched.map(({ row, category }) => ({
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update: learnedUpdate(category),
      guardColumn: "category",
    })),
  );
  return unmatched;
}

async function applyCategories(db: Db, results: Array<Record<string, string>>, rows: Row[], categories: string[]) {
  const accountByRef = new Map(rows.map((r) => [r.entry_reference, r.account_uid]));
  const items = [];
  let invalid = 0;
  for (const { entry_reference, category } of results) {
    const account_uid = accountByRef.get(entry_reference);
    if (!account_uid) continue; // model echoed a reference we never sent
    if (!categories.includes(category)) {
      invalid++;
      continue;
    }
    items.push({ account_uid, entry_reference, update: { category, category_source: "ai" }, guardColumn: "category" });
  }
  if (invalid > 0) console.warn(`Skipping ${invalid} invalid category result(s).`);
  await applyGroupedUpdates(db, items);
}

async function categorizeWithAi(db: Db, rules: Rule[], classify: Classify, timeLeft: () => boolean) {
  let total = 0;
  const stalls = createStallGuard();
  while (timeLeft()) {
    const rows = await fetchBatchForOneUser(db, {
      select: "entry_reference, account_uid, creditor_name, debtor_name, remittance_info, amount, currency, credit_debit_indicator",
      nullColumn: "category",
      limit: BATCH_SIZE,
      excludeUserIds: stalls.stuckUserIds,
    });
    if (rows.length === 0) break;
    if (stalls.isStalled(rows as Array<{ user_id: string; account_uid: string; entry_reference: string }>)) {
      console.warn("No progress for one user, skipping them for this run.");
      continue;
    }
    const { matched, unmatched: afterRules } = applyRules(rows, rules);
    await applyRuleMatches(db, matched);
    const unmatched = await learnFrom(db, afterRules);
    if (unmatched.length > 0) {
      const categories = await fetchUserCategories(db, unmatched[0].user_id);
      await applyCategories(db, await classify(unmatched as CategorizeRow[], categories), unmatched, categories);
    }
    total += rows.length;
  }
  return total;
}

// Recent AI rows whose merchant you later categorized by hand take your category, so one
// correction fixes the merchant's other rows too. Guarded on category_source = 'ai'.
// ponytail: reads 120 days of AI rows with no time check; a few pages for one person.
async function relearnAiRows(db: Db): Promise<number> {
  const since = new Date(Date.now() - RELEARN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows: Row[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await db
      .from("transactions")
      .select("user_id, account_uid, entry_reference, creditor_name, category, category_source")
      .eq("category_source", "ai")
      .gte("booking_date", since)
      .is("deleted_at", null)
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  let changed = 0;
  for (const userRows of Map.groupBy(rows, (r) => r.user_id).values()) {
    const learned = await fetchLearned(db, userRows[0].user_id, userRows.map((r) => r.creditor_name));
    const plan = planRelearn(userRows, learned);
    await applyGroupedUpdates(
      db,
      plan.map(({ row, category }) => ({
        account_uid: row.account_uid,
        entry_reference: row.entry_reference,
        update: learnedUpdate(category),
        guardColumn: "category_source",
        guardIn: ["ai"],
      })),
    );
    changed += plan.length;
  }
  return changed;
}

// Rules and past choices alone, over every uncategorized row (no AI key, or the AI failed).
function applyRulesOnly(db: Db, rules: Rule[], timeLeft: () => boolean): Promise<number> {
  return walkNullRows(db, {
    timeLeft,
    select: "user_id, account_uid, entry_reference, creditor_name, remittance_info",
    nullColumn: "category",
    handlePage: async (rows) => {
      const { matched, unmatched } = applyRules(rows, rules);
      await applyRuleMatches(db, matched);
      let learned = 0;
      for (const userRows of Map.groupBy(unmatched, (r) => r.user_id).values()) {
        learned += userRows.length - (await learnFrom(db, userRows)).length;
      }
      return matched.length + learned;
    },
  });
}

/** classify: null when there is no AI key. Returns how many rows each path looked at. */
export async function categorize(db: Db, classify: Classify | null, timeLeft: () => boolean = () => true) {
  const rules = await fetchRules(db);
  if (!classify) return { categorized: 0, relearned: 0, byRules: await applyRulesOnly(db, rules, timeLeft), aiFailed: false };
  try {
    const categorized = await categorizeWithAi(db, rules, classify, timeLeft);
    const relearned = timeLeft() ? await relearnAiRows(db) : 0;
    return { categorized, relearned, byRules: 0, aiFailed: false };
  } catch (err) {
    console.error(`AI categorization failed, applying your rules only: ${errorTag(err)}`);
    return { categorized: 0, relearned: 0, byRules: await applyRulesOnly(db, rules, timeLeft), aiFailed: true };
  }
}
