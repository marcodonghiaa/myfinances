require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { classifyWithGemini, UNTRUSTED_TEXT_NOTE } = require('./gemini-classify');
const { fetchBatchForOneUser } = require('./user-batch');
const { createStallGuard } = require('./stall-guard');
const { applyGroupedUpdates } = require('./batch-update');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const BATCH_SIZE = 40;

const TYPES = ['Subscription', 'One-time'];

function fetchUnclassified(excludeUserIds) {
  return fetchBatchForOneUser(supabase, {
    select: 'entry_reference, account_uid, creditor_name, remittance_info, amount, currency, credit_debit_indicator, category, bank_transaction_code',
    nullColumn: 'transaction_type',
    limit: BATCH_SIZE,
    excludeUserIds,
  });
}

// A P2P/wire transfer is always One-time regardless of what category it landed in --
// e.g. a Spotify-split payment to a friend gets category "Entertainment" (correctly,
// per its remittance note) but is still a one-off transfer, not a real subscription
// billing relationship. Checking category alone loses that signal once the AI
// reclassifies the category away from the generic "Transfer" bucket, so this checks
// the bank's own transfer code instead.
function isTransferCode(code) {
  if (!code) return false;
  const c = code.toLowerCase();
  return c === 'transfer' || c.includes('bonifico');
}

// Transfers are always One-time by definition -- deterministic, not an AI judgment
// call, and it skips the API call entirely for these rows.
async function applyTransferDefault(rows) {
  await applyGroupedUpdates(
    supabase,
    rows.map((r) => ({
      account_uid: r.account_uid,
      entry_reference: r.entry_reference,
      update: { transaction_type: 'One-time' },
      guardColumn: 'transaction_type',
    })),
  );
}

async function classifyBatch(rows) {
  const prompt = `You are classifying personal bank transactions as either "Subscription" or "One-time".

Rules:
- "Subscription" = recurring billing: streaming (Netflix, Spotify), SaaS/software (Anthropic, Google One, iCloud), memberships, gyms, insurance, phone/internet plans, cloud hosting, subscription boxes — anything billed on a repeating schedule.
- "One-time" = everything else: groceries, restaurants, one-off purchases, transfers, salary/income, fees, travel bookings, etc.
- Base your judgement on creditor_name and remittance_info — merchant/reference text that may be messy, abbreviated, or in a foreign language. If genuinely ambiguous, default to "One-time".

${UNTRUSTED_TEXT_NOTE}

Transactions (JSON array):
${JSON.stringify(rows.map((r) => ({
  entry_reference: r.entry_reference,
  creditor_name: r.creditor_name,
  remittance_info: r.remittance_info,
  amount: r.amount,
  currency: r.currency,
  direction: r.credit_debit_indicator,
})), null, 2)}

Return a JSON array of {"entry_reference": string, "transaction_type": string} for every transaction above, same order, one entry each. transaction_type must be exactly one of the allowed values.`;

  return classifyWithGemini({
    prompt,
    resultKey: 'transaction_type',
    resultEnum: TYPES,
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
  });
}

async function applyTypes(results, rows) {
  const accountByRef = new Map(rows.map((r) => [r.entry_reference, r.account_uid]));
  const items = [];
  for (const { entry_reference, transaction_type } of results) {
    const account_uid = accountByRef.get(entry_reference);
    if (!account_uid) continue; // model echoed a reference we never sent
    if (!TYPES.includes(transaction_type)) {
      console.warn(`Skipping invalid type "${transaction_type}" for ${entry_reference}`);
      continue;
    }
    items.push({ account_uid, entry_reference, update: { transaction_type }, guardColumn: 'transaction_type' });
  }
  await applyGroupedUpdates(supabase, items);
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing from .env');

  let totalClassified = 0;
  const stalls = createStallGuard();
  while (true) {
    const rows = await fetchUnclassified(stalls.stuckUserIds);
    if (rows.length === 0) break;

    if (stalls.isStalled(rows)) {
      console.warn(`No progress for user ${rows[0].user_id}, skipping them for this run.`);
      continue;
    }

    const transferRows = rows.filter((r) => isTransferCode(r.bank_transaction_code));
    const otherRows = rows.filter((r) => !isTransferCode(r.bank_transaction_code));

    if (transferRows.length > 0) {
      console.log(`Setting ${transferRows.length} transfer(s) to One-time...`);
      await applyTransferDefault(transferRows);
    }

    if (otherRows.length > 0) {
      console.log(`Classifying ${otherRows.length} transaction(s)...`);
      const results = await classifyBatch(otherRows);
      await applyTypes(results, otherRows);
    }

    totalClassified += rows.length;

  }

  console.log(`Done. Classified ${totalClassified} transaction(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
