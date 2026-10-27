// Push reminder before a bank's access (PSD2 consent, 180 days) runs out. After that the bank
// stops syncing with no error the user sees; the dashboard's Accounts page also shows a banner.
// Meant to run once a day: each threshold day is hit by one run, so no "already sent" state.
const { errorTag } = require('./log-safe');

const NOTICE_DAYS = [7, 1, 0];
const DAY_MS = 24 * 60 * 60 * 1000;

// "Revolut EUR" -> "Revolut": a bank's accounts share one consent (same rule as the dashboard).
function bankName(label) {
  const parts = (label || 'Bank').trim().split(/\s+/);
  return parts.length > 1 && /^[A-Z]{3}$/.test(parts[parts.length - 1]) ? parts.slice(0, -1).join(' ') : parts.join(' ');
}

function consentNotices(accounts, today) {
  const todayUtc = Date.parse(today.toISOString().slice(0, 10));
  const soonest = new Map(); // user_id -> Map(bank -> daysLeft)
  for (const a of accounts) {
    if (!a.consent_valid_until) continue;
    const daysLeft = Math.round((Date.parse(a.consent_valid_until.slice(0, 10)) - todayUtc) / DAY_MS);
    const banks = soonest.get(a.user_id) ?? new Map();
    const bank = bankName(a.label);
    banks.set(bank, Math.min(daysLeft, banks.get(bank) ?? Infinity));
    soonest.set(a.user_id, banks);
  }
  const notices = [];
  for (const [user_id, banks] of soonest) {
    const due = [...banks]
      .filter(([, daysLeft]) => NOTICE_DAYS.includes(daysLeft))
      .map(([bank, daysLeft]) => ({ bank, daysLeft }))
      .sort((x, y) => x.daysLeft - y.daysLeft);
    if (due.length > 0) notices.push({ user_id, banks: due });
  }
  return notices;
}

function when(daysLeft) {
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  return `in ${daysLeft} days`;
}

function buildConsentPayload(banks) {
  const parts = banks.map((b, i) => (i === 0 ? `${b.bank} stops syncing ${when(b.daysLeft)}` : `${b.bank} ${when(b.daysLeft)}`));
  return { title: 'Renew bank access', body: `${parts.join(', ')}. Tap to renew.`, url: '/accounts' };
}

module.exports = { consentNotices, buildConsentPayload };

async function main() {
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  const { fetchSubscriptions, sendToAllSubscriptions } = require('./push');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

  const { data, error } = await supabase
    .from('accounts')
    .select('user_id, label, consent_valid_until')
    .not('consent_valid_until', 'is', null);
  if (error) throw error;

  const notices = consentNotices(data, new Date());
  if (notices.length === 0) {
    console.log('No bank access to renew soon.');
    return;
  }
  for (const [i, { user_id, banks }] of notices.entries()) {
    const subscriptions = await fetchSubscriptions(supabase, user_id);
    if (subscriptions.length === 0) {
      console.log(`User ${i + 1}/${notices.length}: bank access ending soon, but no push subscription on file.`);
      continue;
    }
    const delivered = await sendToAllSubscriptions(supabase, subscriptions, buildConsentPayload(banks));
    console.log(`User ${i + 1}/${notices.length}: renewal reminder ${delivered ? 'sent' : 'failed'} for ${banks.length} bank(s).`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}
