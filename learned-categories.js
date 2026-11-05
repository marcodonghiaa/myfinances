// What you set by hand is the best guess for the next transaction from the same merchant:
// before the AI, a new row takes the category you most recently chose for that merchant's
// other rows (category_source 'manual'). Rules you wrote still come first.

const PAGE = 1000;

// Most recent hand-set category per merchant, for one user and the merchants in `names`.
async function fetchLearned(supabase, userId, names) {
  const unique = [...new Set(names.filter(Boolean))];
  const learned = new Map();
  if (unique.length === 0) return learned;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('creditor_name, category, booking_date')
      .eq('user_id', userId)
      .eq('category_source', 'manual')
      .in('creditor_name', unique)
      .not('category', 'is', null)
      .is('deleted_at', null)
      .order('booking_date', { ascending: false })
      .order('entry_reference', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data) if (!learned.has(r.creditor_name)) learned.set(r.creditor_name, r.category);
    if (data.length < PAGE) return learned;
  }
}

// Rows whose merchant has a learned category, and the rest (left for the AI).
function applyLearned(rows, learned) {
  const matched = [];
  const unmatched = [];
  for (const row of rows) {
    const category = row.creditor_name ? learned.get(row.creditor_name) : undefined;
    if (category) matched.push({ row, category });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

// The update for a learned row. Transfer also leaves spending and income, as when you pick
// it in the dashboard.
function learnedUpdate(category) {
  return category === 'Transfer'
    ? { category, category_source: 'rule', flow_type: 'transfer' }
    : { category, category_source: 'rule' };
}

// AI-chosen rows that disagree with what you set by hand for the same merchant. Only rows the
// AI categorized are ever changed: hand-set and rule rows stay as they are.
function planRelearn(aiRows, learned) {
  return aiRows
    .filter((r) => r.category_source === 'ai' && r.creditor_name && learned.has(r.creditor_name))
    .filter((r) => learned.get(r.creditor_name) !== r.category)
    .map((r) => ({ row: r, category: learned.get(r.creditor_name) }));
}

module.exports = { fetchLearned, applyLearned, learnedUpdate, planRelearn };
