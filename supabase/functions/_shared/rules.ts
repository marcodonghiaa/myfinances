// Deno port of rules.js: deterministic user-authored rules take priority over the AI.
import type { RowUpdate } from "./batch-update.ts";

export const REAPPLY_SOURCES = ["ai", "rule"]; // never 'manual' or 'legacy': hand edits are not ours

export interface Rule {
  user_id: string;
  match_field: string;
  match_text: string | null;
  match_mode?: string | null; // 'contains' (default, older rules), 'word' or 'exact'
  set_category?: string | null;
  set_transaction_type?: string | null;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export function matchRule(row: Row, rule: Rule): boolean {
  if (rule.user_id !== row.user_id) return false; // rules are per-user; the service role sees everyone's
  if (!rule.match_text) return false; // no text to match -- skip, don't crash or match everything
  const text = rule.match_text.trim().toLowerCase();
  if (!text) return false;
  const fields = rule.match_field === "any" ? [row.creditor_name, row.remittance_info] : [row[rule.match_field]];
  return fields.some((f) => matchesText((f || "").toLowerCase(), text, rule.match_mode));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 'word': the text must stand alone ("bar" matches "Bar Roma", not "Barclays"); 'exact': the
// whole field; anything else is the old substring match, so existing rules keep working.
export function matchesText(field: string, text: string, mode?: string | null): boolean {
  if (mode === "exact") return field.trim() === text;
  if (mode === "word") return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(text)}(?![\\p{L}\\p{N}])`, "u").test(field);
  return field.includes(text);
}

export function applyRules<T extends Row>(rows: T[], rules: Rule[]) {
  const matched: Array<{ row: T; rule: Rule }> = [];
  const unmatched: T[] = [];
  for (const row of rows) {
    const rule = rules.find((r) => matchRule(row, r));
    if (rule) matched.push({ row, rule });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

// Rows already categorized by the AI or an earlier rule get the (possibly new) rule's
// category. Hand-set categories are excluded here and again by the statement's guard.
export function planRuleReapply(rows: Row[], rules: Rule[]): RowUpdate[] {
  const usable = rules.filter((r) => r.set_category);
  const items: RowUpdate[] = [];
  for (const row of rows) {
    if (!REAPPLY_SOURCES.includes(row.category_source)) continue;
    const rule = usable.find((r) => matchRule(row, r));
    if (!rule || rule.set_category === row.category) continue;
    items.push({
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update: { category: rule.set_category, category_source: "rule" },
      guardColumn: "category_source",
      guardIn: REAPPLY_SOURCES,
    });
  }
  return items;
}
