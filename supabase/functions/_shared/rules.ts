// Deno port of rules.js: deterministic user-authored rules take priority over the AI.
import type { RowUpdate } from "./batch-update.ts";

export const REAPPLY_SOURCES = ["ai", "rule"]; // never 'manual' or 'legacy': hand edits are not ours
// Every step that runs rules reads these columns (flow and type rules select their own action).
export const RULE_MATCH_COLUMNS = "user_id, match_field, match_text, match_mode";
const TRANSFER = "Transfer";

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
  if (!rule.match_text?.trim()) return false; // no text to match -- skip, don't crash or match everything
  const fields = rule.match_field === "any" ? [row.creditor_name, row.remittance_info] : [row[rule.match_field]];
  return fields.some((f) => matchesText(fold(f || ""), fold(rule.match_text!), rule.match_mode));
}

// Same letters, same case: "Café" typed one way matches "Café" stored the other way.
const fold = (s: string) => s.normalize("NFC").toLowerCase();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}]";
const isWordChar = (c: string) => new RegExp(WORD_CHAR, "u").test(c);

// 'word': the text must stand alone ("bar" matches "Bar Roma", not "Barclays"; a boundary is
// only checked on an edge that is a letter or digit, so "amazon." still matches "amazon.it");
// 'exact': the whole field. Both ignore spaces around the text. Anything else is the old
// substring match, text as typed, so existing rules keep working.
function matchesText(field: string, text: string, mode?: string | null): boolean {
  if (mode === "exact") return field.trim() === text.trim();
  if (mode !== "word") return field.includes(text);
  const t = text.trim();
  const chars = [...t];
  const before = isWordChar(chars[0]) ? `(?<!${WORD_CHAR})` : "";
  const after = isWordChar(chars[chars.length - 1]) ? `(?!${WORD_CHAR})` : "";
  return new RegExp(before + escapeRegExp(t) + after, "u").test(field);
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
// Transfer is left alone both ways: whether a row counts as spending was decided from its
// category at sync time (flow.ts), and re-applying doesn't redo that.
export function planRuleReapply(rows: Row[], rules: Rule[]): RowUpdate[] {
  const usable = rules.filter((r) => r.set_category);
  const items: RowUpdate[] = [];
  for (const row of rows) {
    if (!REAPPLY_SOURCES.includes(row.category_source)) continue;
    const rule = usable.find((r) => matchRule(row, r));
    if (!rule || rule.set_category === row.category) continue;
    if (row.category === TRANSFER || rule.set_category === TRANSFER) continue;
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
