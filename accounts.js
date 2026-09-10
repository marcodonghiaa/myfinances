// Guest demo account (public /demo page seed data) -- its accounts.uid rows are
// fake, not real Enable Banking accounts, so the sync pipeline must skip it.
const GUEST_USER_ID = '88218f96-7cd3-4400-9080-20859c72a986';

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

// Every real user with at least one linked bank account -- what the sync
// pipeline loops over instead of a single hardcoded USER_ID.
async function getAllUserIds(supabase) {
  const { data, error } = await supabase.from('accounts').select('user_id');
  if (error) throw new Error(`Failed to load user ids: ${error.message}`);
  const ids = new Set((data || []).map((row) => row.user_id));
  ids.delete(GUEST_USER_ID);
  return Array.from(ids);
}

module.exports = { getAccounts, getAllUserIds, GUEST_USER_ID };
