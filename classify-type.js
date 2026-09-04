require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const BATCH_SIZE = 40;

const TYPES = ['Subscription', 'One-time'];

async function fetchUnclassified() {
  const { data, error } = await supabase
    .from('transactions')
    .select('entry_reference, creditor_name, remittance_info, amount, currency, credit_debit_indicator')
    .is('transaction_type', null)
    .limit(BATCH_SIZE);
  if (error) throw error;
  return data;
}

async function classifyBatch(rows) {
  const prompt = `You are classifying personal bank transactions as either "Subscription" or "One-time".

Rules:
- "Subscription" = recurring billing: streaming (Netflix, Spotify), SaaS/software (Anthropic, Google One, iCloud), memberships, gyms, insurance, phone/internet plans, cloud hosting, subscription boxes — anything billed on a repeating schedule.
- "One-time" = everything else: groceries, restaurants, one-off purchases, transfers, salary/income, fees, travel bookings, etc.
- Base your judgement on creditor_name and remittance_info — merchant/reference text that may be messy, abbreviated, or in a foreign language. If genuinely ambiguous, default to "One-time".

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

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                entry_reference: { type: 'STRING' },
                transaction_type: { type: 'STRING', enum: TYPES },
              },
              required: ['entry_reference', 'transaction_type'],
            },
          },
        },
      }),
    }
  );

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Unexpected Gemini response: ${JSON.stringify(data)}`);
  return JSON.parse(text);
}

async function applyTypes(results) {
  for (const { entry_reference, transaction_type } of results) {
    if (!TYPES.includes(transaction_type)) {
      console.warn(`Skipping invalid type "${transaction_type}" for ${entry_reference}`);
      continue;
    }
    // .is('transaction_type', null) guard: only ever fills in the type, never overwrites
    // a value set by something else in the meantime.
    const { error } = await supabase
      .from('transactions')
      .update({ transaction_type })
      .eq('entry_reference', entry_reference)
      .is('transaction_type', null);
    if (error) console.error(`Failed to update ${entry_reference}:`, error.message);
  }
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing from .env');

  let totalClassified = 0;
  while (true) {
    const rows = await fetchUnclassified();
    if (rows.length === 0) break;

    console.log(`Classifying ${rows.length} transaction(s)...`);
    const results = await classifyBatch(rows);
    await applyTypes(results);
    totalClassified += rows.length;

    if (rows.length < BATCH_SIZE) break; // fewer than a full page means we're caught up
  }

  console.log(`Done. Classified ${totalClassified} transaction(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
