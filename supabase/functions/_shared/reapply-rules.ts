// "Apply to past transactions" on the dashboard's Rules page: re-runs your current rules over
// rows the AI or an earlier rule categorized. Hand-set categories (category_source 'manual' or
// 'legacy') are never read and the update guards on the same column (see planRuleReapply).
// db is the service-role client (so the hand-edit trigger doesn't mark these rows 'manual');
// every read and write is scoped to userId.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { planRuleReapply, REAPPLY_SOURCES, RULE_MATCH_COLUMNS, type Rule } from "./rules.ts";

const PAGE_SIZE = 1000;
const SAMPLE_SIZE = 5;

export interface ReapplyResult {
  changes: number;
  sample: Array<{ name: string; from: string | null; to: string }>;
}

// apply=false is the preview: same plan, nothing written.
export async function reapplyRules(db: Db, userId: string, apply: boolean): Promise<ReapplyResult> {
  const { data: rules, error: rulesError } = await db
    .from("category_rules")
    .select(`${RULE_MATCH_COLUMNS}, set_category, set_transaction_type`)
    .eq("user_id", userId)
    .not("set_category", "is", null)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (rulesError) throw rulesError;
  if (!rules?.length) return { changes: 0, sample: [] };

  // Read every page first, then write: updates never shift the pages still to be read.
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("transactions")
      .select("user_id, account_uid, entry_reference, creditor_name, remittance_info, category, category_source")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .in("category_source", REAPPLY_SOURCES)
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  const items = planRuleReapply(rows, rules as Rule[]);
  const byKey = new Map(rows.map((r) => [`${r.account_uid}\u0000${r.entry_reference}`, r]));
  const sample = items.slice(0, SAMPLE_SIZE).map((item) => {
    const row = byKey.get(`${item.account_uid}\u0000${item.entry_reference}`);
    return { name: row.creditor_name || row.remittance_info || "", from: row.category, to: item.update.category as string };
  });
  if (apply) {
    const failed = await applyGroupedUpdates(db, items, userId);
    if (failed) throw new Error(`${failed} update(s) failed`);
  }
  return { changes: items.length, sample };
}
