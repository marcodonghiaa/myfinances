const REAPPLY_SOURCES = ['ai', 'rule']; // never 'manual' or 'legacy': hand edits are not ours to overwrite

const TRANSFER = 'Transfer';

function matchRule(row, rule) {
  if (rule.user_id !== row.user_id) return false; // rules are per-user; the service role sees everyone's
  if (!rule.match_text?.trim()) return false; // no text to match -- skip, don't crash or match everything
  const fields =
    rule.match_field === 'any'
      ? [row.creditor_name, row.remittance_info]
      : [row[rule.match_field]];
  return fields.some((f) => matchesText(fold(f || ''), fold(rule.match_text), rule.match_mode));
}

// Same letters, same case: "Café" typed one way matches "Café" stored the other way.
const fold = (s) => s.normalize('NFC').toLowerCase();
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHAR = '[\\p{L}\\p{N}\\p{M}]';
const isWordChar = (c) => new RegExp(WORD_CHAR, 'u').test(c);

// 'word': the text must stand alone ("bar" matches "Bar Roma", not "Barclays"; a boundary is
// only checked on an edge that is a letter or digit, so "amazon." still matches "amazon.it");
// 'exact': the whole field. Both ignore spaces around the text. Anything else is the old
// substring match, text as typed, so existing rules keep working.
function matchesText(field, text, mode) {
  if (mode === 'exact') return field.trim() === text.trim();
  if (mode !== 'word') return field.includes(text);
  const t = text.trim();
  const chars = [...t];
  const before = isWordChar(chars[0]) ? `(?<!${WORD_CHAR})` : '';
  const after = isWordChar(chars[chars.length - 1]) ? `(?!${WORD_CHAR})` : '';
  return new RegExp(before + escapeRegExp(t) + after, 'u').test(field);
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
// Transfer is left alone both ways: whether a row counts as spending was decided from its
// category at sync time (classify-flow.js), and re-applying doesn't redo that.
function planRuleReapply(rows, rules) {
  const usable = rules.filter((r) => r.set_category);
  const items = [];
  for (const row of rows) {
    if (!REAPPLY_SOURCES.includes(row.category_source)) continue;
    const rule = usable.find((r) => matchRule(row, r));
    if (!rule || rule.set_category === row.category) continue;
    if (row.category === TRANSFER || rule.set_category === TRANSFER) continue;
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
