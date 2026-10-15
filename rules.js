const REAPPLY_SOURCES = ['ai', 'rule']; // never 'manual' or 'legacy': hand edits are not ours to overwrite

function matchRule(row, rule) {
  if (rule.user_id !== row.user_id) return false; // rules are per-user; the service role sees everyone's
  if (!rule.match_text) return false; // no text to match -- skip, don't crash or match everything
  const text = rule.match_text.toLowerCase();
  const fields =
    rule.match_field === 'any'
      ? [row.creditor_name, row.remittance_info]
      : [row[rule.match_field]];
  return fields.some((f) => (f || '').toLowerCase().includes(text));
}

// Deterministic user-authored rules take priority over the AI -- cheaper, faster,
// and exactly what the user asked for, not a guess.
function applyRules(rows, rules) {
  const matched = [];
  const unmatched = [];
  for (const row of rows) {
    const rule = rules.find((r) => matchRule(row, r));
    if (rule) matched.push({ row, rule });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

// Rows already categorized by the AI or an earlier rule get the (possibly new) rule's
// category. Hand-set categories are excluded here and again by the statement's guard.
function planRuleReapply(rows, rules) {
  const usable = rules.filter((r) => r.set_category);
  const items = [];
  for (const row of rows) {
    if (!REAPPLY_SOURCES.includes(row.category_source)) continue;
    const rule = usable.find((r) => matchRule(row, r));
    if (!rule || rule.set_category === row.category) continue;
    items.push({
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update: { category: rule.set_category, category_source: 'rule' },
      guardColumn: 'category_source',
      guardIn: REAPPLY_SOURCES,
    });
  }
  return items;
}

module.exports = { matchRule, applyRules, planRuleReapply, REAPPLY_SOURCES };
