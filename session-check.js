require('dotenv').config();

// Each linked bank has its own Enable Banking consent (accounts.consent_valid_until),
// so this warns per-account instead of exiting the whole process — one expired bank
// shouldn't block syncing the others.
async function checkSessionExpiry(supabase, userId) {
  const { data, error } = await supabase
    .from('accounts')
    .select('label, consent_valid_until')
    .eq('user_id', userId)
    .not('consent_valid_until', 'is', null);
  if (error) throw error;

  const now = new Date();
  const rows = data || [];
  for (const [i, row] of rows.entries()) {
    const validUntil = new Date(row.consent_valid_until);
    const daysLeft = Math.ceil((validUntil - now) / (1000 * 60 * 60 * 24));

    if (daysLeft <= 0) {
      console.error(`\n⚠️  Account ${i + 1}/${rows.length}: Enable Banking consent EXPIRED. Re-link this bank from the dashboard's Accounts page.\n`);
    } else if (daysLeft <= 14) {
      console.warn(`\n⚠️  Account ${i + 1}/${rows.length}: Enable Banking consent expires in ${daysLeft} day(s). Plan to re-authorize soon.\n`);
    }
  }
}

module.exports = { checkSessionExpiry };
