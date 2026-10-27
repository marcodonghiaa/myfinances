async function getAccounts(supabase, userId) {
  const { data, error } = await supabase
    .from('accounts')
    .select('uid, currency, label, created_at, iban, identification_hash, eb_account_uid')
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
  return Array.from(ids);
}

// The id Enable Banking answers to now: a renewed consent can give the same bank
// account a new id (eb_account_uid); null means uid is still it.
function ebAccountId(account) {
  return account.eb_account_uid || account.uid;
}

// EB /accounts/{id}/details -> accounts update. identification_hash is what
// recognises the account across renewals; without it there is nothing to store.
function idsPatchFromDetails(details) {
  if (!details?.identification_hash) return null;
  const iban = details.account_id?.iban;
  return { identification_hash: details.identification_hash, ...(iban && { iban }) };
}

// Statuses with which EB refuses an account id (dead or expired consent).
const EB_REJECTED_STATUSES = new Set([401, 403, 404, 422]);

module.exports = { getAccounts, getAllUserIds, ebAccountId, idsPatchFromDetails, EB_REJECTED_STATUSES };
