async function getAccounts(supabase, userId) {
  const { data, error } = await supabase
    .from('accounts')
    .select('uid, currency, label')
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to load accounts: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('No accounts found for this user_id — add a row to the accounts table first.');
  }

  return data;
}

module.exports = { getAccounts };
