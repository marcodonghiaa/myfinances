// The sync scripts run with the service role and send bank-provided text to an LLM.
// Mixing users in one batch lets text one user receives (a payer controls the payment
// reference) influence how other users' rows are labelled, so each batch is scoped
// to a single user.
// excludeUserIds: users to skip (e.g. ones whose rows keep failing), so they can't block the rest.
async function fetchBatchForOneUser(supabase, { select, nullColumn, limit, excludeUserIds = new Set() }) {
  const pending = (cols) => {
    const q = supabase.from('transactions').select(cols).is(nullColumn, null);
    return excludeUserIds.size > 0 ? q.not('user_id', 'in', `(${[...excludeUserIds].join(',')})`) : q;
  };

  const { data: first, error: firstError } = await pending('user_id').limit(1);
  if (firstError) throw firstError;
  if (!first || first.length === 0) return [];

  const { data, error } = await pending(`user_id, ${select}`).eq('user_id', first[0].user_id).limit(limit);
  if (error) throw error;
  return data;
}

module.exports = { fetchBatchForOneUser };
