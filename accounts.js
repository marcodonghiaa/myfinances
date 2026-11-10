const ACCOUNT_COLUMNS = 'uid, currency, label, created_at, iban, identification_hash, consent_valid_until';

// Newest columns first: 42703 (undefined column) means that migration isn't applied yet, so
// read again without it. eb_account_uid missing: ebAccountId falls back to uid. manual
// missing: there are no manual accounts yet. account_type missing: it is never filled.
const OPTIONAL_COLUMNS = [', eb_account_uid, manual, account_type', ', eb_account_uid, manual', ', eb_account_uid', ''];

async function selectNewest(supabase, base, filter) {
  for (const extra of OPTIONAL_COLUMNS) {
    let query = supabase.from('accounts').select(`${base}${extra}`);
    if (filter) query = filter(query);
    const { data, error } = await query;
    if (error?.code === '42703' && extra) continue;
    if (!extra) console.warn('Reading accounts without eb_account_uid: apply the latest migrations.');
    return { data, error };
  }
}

// Bank accounts only: manual accounts (transactions typed in by hand) have no bank to sync.
async function getAccounts(supabase, userId) {
  const { data, error } = await selectNewest(supabase, ACCOUNT_COLUMNS, (q) => q.eq('user_id', userId));
  if (error) throw new Error(`Failed to load accounts: ${error.message}`);
  const bank = (data || []).filter((a) => !a.manual);
  if (bank.length === 0) {
    throw new Error('No accounts found for this user_id — add a row to the accounts table first.');
  }

  return bank;
}

// Every real user with at least one linked bank account -- what the sync
// pipeline loops over instead of a single hardcoded USER_ID. Someone with only
// manual transactions has nothing to sync.
async function getAllUserIds(supabase) {
  let { data, error } = await supabase.from('accounts').select('user_id, manual');
  if (error?.code === '42703') ({ data, error } = await supabase.from('accounts').select('user_id'));
  if (error) throw new Error(`Failed to load user ids: ${error.message}`);
  const ids = new Set((data || []).filter((row) => !row.manual).map((row) => row.user_id));
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

// Enable Banking cash_account_type (ISO 20022) -> accounts.account_type. null = not sent.
// Same map as supabase/functions/_shared/account-match.ts.
const CASH_ACCOUNT_TYPES = { CACC: 'checking', SVGS: 'savings', CARD: 'credit_card', LOAN: 'loan' };
function accountType(cashAccountType) {
  if (typeof cashAccountType !== 'string' || cashAccountType === '') return null;
  return CASH_ACCOUNT_TYPES[cashAccountType.toUpperCase()] ?? 'other';
}

// Statuses with which EB refuses an account id (dead or expired consent).
const EB_REJECTED_STATUSES = new Set([401, 403, 404, 422]);

module.exports = { getAccounts, getAllUserIds, ebAccountId, idsPatchFromDetails, accountType, EB_REJECTED_STATUSES };
