// "Apply to past transactions" on the dashboard's Rules page: re-runs your current rules over
// rows the AI or an earlier rule categorized. Hand-set categories (category_source 'manual' or
// 'legacy') are never read and the update guards on the same column (see planRuleReapply).
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { planRuleReapply, REAPPLY_SOURCES, type Rule } from "./rules.ts";

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
    .select("user_id, match_field, match_text, match_mode, set_category, set_transaction_type")
    .eq("user_id", userId)
    .not("set_category", "is", null)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (rulesError) throw rulesError;
  const result: ReapplyResult = { changes: 0, sample: [] };
  if (!rules?.length) return result;

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: rows, error } = await db
      .from("transactions")
      .select("user_id, account_uid, entry_reference, creditor_name, remittance_info, category, category_source")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .in("category_source", REAPPLY_SOURCES)
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const items = planRuleReapply(rows, rules as Rule[]);
    for (const item of items) {
      if (result.sample.length >= SAMPLE_SIZE) break;
      const row = rows.find((r: Record<string, string>) => r.account_uid === item.account_uid && r.entry_reference === item.entry_reference);
      result.sample.push({ name: row.creditor_name || row.remittance_info || "", from: row.category, to: item.update.category as string });
    }
    if (apply) await applyGroupedUpdates(db, items);
    result.changes += items.length;
    if (rows.length < PAGE_SIZE) break;
  }
  return result;
}
