// The sync scripts run with the service role and send bank-provided text to an LLM.
// Mixing users in one batch lets text one user receives (a payer controls the payment
// reference) influence how other users' rows are labelled, so each batch is scoped
// to a single user.
// excludeUserIds: users to skip (e.g. ones whose rows keep failing), so they can't block the rest.
async function fetchBatchForOneUser(supabase, { table = 'transactions', select, nullColumn, limit, excludeUserIds = new Set() }) {
  const pending = (cols) => {
    const q = supabase.from(table).select(cols).is(nullColumn, null);
    return excludeUserIds.size > 0 ? q.not('user_id', 'in', `(${[...excludeUserIds].join(',')})`) : q;
  };

  const { data: first, error: firstError } = await pending('user_id').limit(1);
  if (firstError) throw firstError;
  if (!first || first.length === 0) return [];

  const { data, error } = await pending(`user_id, ${select}`).eq('user_id', first[0].user_id).limit(limit);
  if (error) throw error;
  return data;
}

// Walks every transaction whose `nullColumn` is still null, for deterministic work that
// sends nothing to an LLM (rules, transfer defaults), so it can span users. `handlePage`
// returns how many rows it filled in: those leave the result set, so the next page starts
// that much earlier. A row whose update failed is retried on the next run.
async function walkNullRows(supabase, { select, nullColumn, pageSize = 1000, handlePage }) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('transactions')
      .select(select)
      .is(nullColumn, null)
      .order('account_uid')
      .order('entry_reference')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (data.length === 0) return total;
    const filled = await handlePage(data);
    total += filled;
    offset += data.length - filled;
    if (data.length < pageSize) return total;
  }
}

module.exports = { fetchBatchForOneUser, walkNullRows };
