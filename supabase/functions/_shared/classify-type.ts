// Deno port of classify-type.js: each transaction is a "Subscription" or "One-time". Your type
// rules first, then bank transfers (always One-time, no AI call), then the AI. Without an AI (no
// key, or it fails) the rules and transfers still apply; the rest waits.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { type Ask, UNTRUSTED_TEXT_NOTE } from "./gemini.ts";
import { errorTag } from "./log-safe.ts";
import { applyRules, type Rule } from "./rules.ts";
import { createStallGuard } from "./stall-guard.ts";
import { fetchBatchForOneUser, walkNullRows } from "./user-batch.ts";

const BATCH_SIZE = 40;
export const TYPES = ["Subscription", "One-time"];

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// A P2P/wire transfer is always One-time whatever category it got (a Spotify split paid to a
// friend is Entertainment but not a subscription), so this reads the bank's transfer code.
export function isTransferCode(code?: string | null): boolean {
  if (!code) return false;
  const c = code.toLowerCase();
  return c === "transfer" || c.includes("bonifico");
}

// Rules that set only a type ("spotify -> Subscription") are applied here, before the AI.
async function fetchTypeRules(db: Db): Promise<Rule[]> {
  const { data, error } = await db
    .from("category_rules")
    .select("user_id, match_field, match_text, match_mode, set_transaction_type")
    .not("set_transaction_type", "is", null)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

const setType = (db: Db, items: Array<{ row: Row; type: string }>) =>
  applyGroupedUpdates(
    db,
    items.map(({ row, type }) => ({
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update: { transaction_type: type },
      guardColumn: "transaction_type",
    })),
  );

// Type rules, then transfers; returns the rows left for the AI.
async function applyDeterministic(db: Db, rows: Row[], rules: Rule[]): Promise<Row[]> {
  const { matched, unmatched } = applyRules(rows, rules);
  await setType(db, matched.map(({ row, rule }) => ({ row, type: rule.set_transaction_type! })));
  const transfers = unmatched.filter((r) => isTransferCode(r.bank_transaction_code));
  await setType(db, transfers.map((row) => ({ row, type: "One-time" })));
  return unmatched.filter((r) => !isTransferCode(r.bank_transaction_code));
}

export function buildTypePrompt(rows: Row[]): string {
  return `You are classifying personal bank transactions as either "Subscription" or "One-time".

Rules:
- "Subscription" = recurring billing: streaming (Netflix, Spotify), SaaS/software (Anthropic, Google One, iCloud), memberships, gyms, insurance, phone/internet plans, cloud hosting, subscription boxes — anything billed on a repeating schedule.
- "One-time" = everything else: groceries, restaurants, one-off purchases, transfers, salary/income, fees, travel bookings, etc.
- Base your judgement on creditor_name and remittance_info — merchant/reference text that may be messy, abbreviated, or in a foreign language. If genuinely ambiguous, default to "One-time".

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

Return a JSON array of {"entry_reference": string, "transaction_type": string} for every transaction above, same order, one entry each. transaction_type must be exactly one of the allowed values.`;
}

async function applyTypes(db: Db, results: Array<Record<string, string>>, rows: Row[]) {
  const byRef = new Map(rows.map((r) => [r.entry_reference, r]));
  const items = [];
  let invalid = 0;
  for (const { entry_reference, transaction_type } of results) {
    const row = byRef.get(entry_reference);
    if (!row) continue; // model echoed a reference we never sent
    if (!TYPES.includes(transaction_type)) {
      invalid++;
      continue;
    }
    items.push({ row, type: transaction_type });
  }
  if (invalid > 0) console.warn(`Skipping ${invalid} invalid type result(s).`);
  await setType(db, items);
}

async function classifyWithAi(db: Db, rules: Rule[], ask: Ask, timeLeft: () => boolean) {
  let total = 0;
  const stalls = createStallGuard();
  while (timeLeft()) {
    const rows = await fetchBatchForOneUser(db, {
      select: "entry_reference, account_uid, creditor_name, remittance_info, amount, currency, credit_debit_indicator, category, bank_transaction_code",
      nullColumn: "transaction_type",
      limit: BATCH_SIZE,
      excludeUserIds: stalls.stuckUserIds,
    });
    if (rows.length === 0) break;
    if (stalls.isStalled(rows as Array<{ user_id: string; account_uid: string; entry_reference: string }>)) {
      console.warn("No progress for one user, skipping them for this run.");
      continue;
    }
    const forAi = await applyDeterministic(db, rows, rules);
    if (forAi.length > 0) await applyTypes(db, await ask(buildTypePrompt(forAi), "transaction_type", TYPES), forAi);
    total += rows.length;
  }
  return total;
}

// Type rules and transfers over every unclassified row (no AI key, or the AI failed).
function applyDeterministicOnly(db: Db, rules: Rule[], timeLeft: () => boolean): Promise<number> {
  return walkNullRows(db, {
    select: "user_id, account_uid, entry_reference, bank_transaction_code, creditor_name, remittance_info",
    nullColumn: "transaction_type",
    timeLeft,
    handlePage: async (rows) => rows.length - (await applyDeterministic(db, rows, rules)).length,
  });
}

/** ask: null when there is no AI key. */
export async function classifyTypes(db: Db, ask: Ask | null, timeLeft: () => boolean = () => true) {
  const rules = await fetchTypeRules(db);
  if (!ask) return { typed: 0, typedByRules: await applyDeterministicOnly(db, rules, timeLeft), typeAiFailed: false };
  try {
    return { typed: await classifyWithAi(db, rules, ask, timeLeft), typedByRules: 0, typeAiFailed: false };
  } catch (err) {
    console.error(`AI type classification failed, applying rules and transfers only: ${errorTag(err)}`);
    return { typed: 0, typedByRules: await applyDeterministicOnly(db, rules, timeLeft), typeAiFailed: true };
  }
}
