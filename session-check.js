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
  for (const row of data || []) {
    const validUntil = new Date(row.consent_valid_until);
    const daysLeft = Math.ceil((validUntil - now) / (1000 * 60 * 60 * 24));

    if (daysLeft <= 0) {
      console.error(`\n⚠️  ${row.label}: Enable Banking consent EXPIRED on ${row.consent_valid_until}. Redo the auth flow (start-auth.js → exchange-code.js) for this bank.\n`);
    } else if (daysLeft <= 14) {
      console.warn(`\n⚠️  ${row.label}: Enable Banking consent expires in ${daysLeft} day(s) (${row.consent_valid_until}). Plan to re-authorize soon.\n`);
    }
  }
}

module.exports = { checkSessionExpiry };
