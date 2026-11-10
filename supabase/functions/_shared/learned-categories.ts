// Deno port of learned-categories.js. What you set by hand is the best guess for the next
// transaction from the same merchant: before the AI, a new row takes the category you most
// recently chose for that merchant's other rows (category_source 'manual'). Rules still come first.
import type { Db } from "./batch-update.ts";

const PAGE = 1000;

// Most recent hand-set category per merchant, for one user and the merchants in `names`.
// ponytail: pages through every matching hand-set row with no time check; one batch's merchants.
export async function fetchLearned(db: Db, userId: string, names: Array<string | null | undefined>) {
  const unique = [...new Set(names.filter(Boolean))];
  const learned = new Map<string, string>();
  if (unique.length === 0) return learned;
  for (let from = 0;; from += PAGE) {
    const { data, error } = await db
      .from("transactions")
      .select("creditor_name, category, booking_date")
      .eq("user_id", userId)
      .eq("category_source", "manual")
      .in("creditor_name", unique)
      .not("category", "is", null)
      .is("deleted_at", null)
      .order("booking_date", { ascending: false })
      .order("entry_reference", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data) if (!learned.has(r.creditor_name)) learned.set(r.creditor_name, r.category);
    if (data.length < PAGE) return learned;
  }
}

// Rows whose merchant has a learned category, and the rest (left for the AI).
export function applyLearned<T extends { creditor_name?: string | null }>(rows: T[], learned: Map<string, string>) {
  const matched: Array<{ row: T; category: string }> = [];
  const unmatched: T[] = [];
  for (const row of rows) {
    const category = row.creditor_name ? learned.get(row.creditor_name) : undefined;
    if (category) matched.push({ row, category });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

// The update for a learned row. A learned Transfer also leaves spending and income: the flow
// step reads the category (flow.ts), after your flow rules, and never over a flow you set.
export const learnedUpdate = (category: string): Record<string, string> => ({ category, category_source: "rule" });

// AI-chosen rows that disagree with what you set by hand for the same merchant. Only rows the
// AI categorized are ever changed: hand-set and rule rows stay as they are.
export function planRelearn<T extends { creditor_name?: string | null; category?: string | null; category_source?: string | null }>(
  aiRows: T[],
  learned: Map<string, string>,
) {
  return aiRows
    .filter((r) => r.category_source === "ai" && r.creditor_name && learned.has(r.creditor_name))
    .filter((r) => learned.get(r.creditor_name!) !== r.category)
    .map((r) => ({ row: r, category: learned.get(r.creditor_name!)! }));
}
