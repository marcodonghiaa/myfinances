// The sync scripts run with the service role and send bank-provided text to an LLM.
// Mixing users in one batch lets text one user receives (a payer controls the payment
// reference) influence how other users' rows are labelled, so each batch is scoped
// to a single user.
async function fetchBatchForOneUser(supabase, { select, nullColumn, limit }) {
  const pending = (cols) => supabase.from('transactions').select(cols).is(nullColumn, null);

  const { data: first, error: firstError } = await pending('user_id').limit(1);
  if (firstError) throw firstError;
  if (!first || first.length === 0) return [];

  const { data, error } = await pending(`user_id, ${select}`).eq('user_id', first[0].user_id).limit(limit);
  if (error) throw error;
  return data;
}

module.exports = { fetchBatchForOneUser };
