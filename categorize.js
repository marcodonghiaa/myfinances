require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const BATCH_SIZE = 40;

const CATEGORIES = [
  'Shopping', 'Entertainment', 'Groceries', 'Dine Out', 'Services', 'Housing',
  'Transports', 'Experiences', 'Income', 'Health', 'Transfer', 'Others',
];

async function fetchUncategorized() {
  const { data, error } = await supabase
    .from('transactions')
    .select('entry_reference, creditor_name, debtor_name, remittance_info, amount, currency, credit_debit_indicator')
    .is('category', null)
    .limit(BATCH_SIZE);
  if (error) throw error;
  return data;
}

async function fetchRules() {
  const { data, error } = await supabase
    .from('category_rules')
    .select('match_field, match_text, set_category, set_transaction_type')
    .not('set_category', 'is', null)
    .order('priority', { ascending: true });
  if (error) throw error;
  return data;
}

function matchRule(row, rule) {
  const text = rule.match_text.toLowerCase();
  const fields =
    rule.match_field === 'any'
      ? [row.creditor_name, row.remittance_info]
      : [row[rule.match_field]];
  return fields.some((f) => (f || '').toLowerCase().includes(text));
}

// Deterministic user-authored rules take priority over the AI -- cheaper, faster,
// and exactly what the user asked for, not a guess.
function applyRules(rows, rules) {
  const matched = [];
  const unmatched = [];
  for (const row of rows) {
    const rule = rules.find((r) => matchRule(row, r));
    if (rule) matched.push({ row, rule });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}

async function classifyBatch(rows) {
  const prompt = `You are categorizing personal bank transactions into exactly one of these categories: ${CATEGORIES.join(', ')}.

Category guide:
- Shopping: clothes, tech purchases (phones, laptops, electronics), Amazon, general retail.
- Entertainment: video games, streaming (Netflix, Spotify), movies, hobbies.
- Groceries: supermarkets, grocery delivery.
- Dine Out: restaurants, cafes, bars, takeout, drinks out.
- Services: mobile/phone plans, internet, insurance, professional services, non-entertainment software/cloud subscriptions (e.g. AI tools, cloud storage).
- Housing: rent, mortgage, utilities (electricity, water, gas bill for the home).
- Transports: bus, car/gas, trains, flights, commuting and transport of any kind.
- Experiences: hotels, events, concerts, tickets, activities while traveling or out.
- Income: incoming payments (credit_debit_indicator CRDT) that look like salary/earnings.
- Health: pharmacy, doctor, gym, fitness, medical expenses.
- Transfer: account-to-account or P2P transfers with no indicated purpose (e.g. splitting rent, paying someone back with no note).
- Others: only if nothing else plausibly fits.

Base your judgement on creditor_name and remittance_info — merchant/reference text that may be messy, abbreviated, or in a foreign language. This matters especially for P2P/bank transfers to a person: creditor_name alone (a person's name) tells you nothing, but remittance_info often does — e.g. a transfer to a friend with remittance_info mentioning "spotify" or "netflix" should be categorized by that actual purpose (Entertainment), not filed under Transfer just because the payment method was a person-to-person transfer. Only use Transfer when nothing in remittance_info indicates a real purpose.

Transactions (JSON array):
${JSON.stringify(rows.map((r) => ({
  entry_reference: r.entry_reference,
  creditor_name: r.creditor_name,
  remittance_info: r.remittance_info,
  amount: r.amount,
  currency: r.currency,
  direction: r.credit_debit_indicator,
})), null, 2)}

Return a JSON array of {"entry_reference": string, "category": string} for every transaction above, same order, one entry each. category must be exactly one of the allowed categories.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
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
                category: { type: 'STRING', enum: CATEGORIES },
              },
              required: ['entry_reference', 'category'],
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

async function applyCategories(results) {
  for (const { entry_reference, category } of results) {
    if (!CATEGORIES.includes(category)) {
      console.warn(`Skipping invalid category "${category}" for ${entry_reference}`);
      continue;
    }
    // .is('category', null) guard: only ever fills in the category, never overwrites
    // a value set by something else in the meantime.
    const { error } = await supabase
      .from('transactions')
      .update({ category })
      .eq('entry_reference', entry_reference)
      .is('category', null);
    if (error) console.error(`Failed to update ${entry_reference}:`, error.message);
  }
}

async function applyRuleMatches(matched) {
  for (const { row, rule } of matched) {
    const update = { category: rule.set_category };
    if (rule.set_transaction_type) update.transaction_type = rule.set_transaction_type;
    const { error } = await supabase
      .from('transactions')
      .update(update)
      .eq('entry_reference', row.entry_reference)
      .is('category', null);
    if (error) console.error(`Failed to apply rule to ${row.entry_reference}:`, error.message);
  }
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing from .env');

  const rules = await fetchRules();
  if (rules.length > 0) console.log(`Loaded ${rules.length} categorization rule(s).`);

  let totalCategorized = 0;
  while (true) {
    const rows = await fetchUncategorized();
    if (rows.length === 0) break;

    const { matched, unmatched } = applyRules(rows, rules);

    if (matched.length > 0) {
      console.log(`Applying ${matched.length} rule match(es)...`);
      await applyRuleMatches(matched);
    }

    if (unmatched.length > 0) {
      console.log(`Categorizing ${unmatched.length} transaction(s) via AI...`);
      const results = await classifyBatch(unmatched);
      await applyCategories(results);
    }

    totalCategorized += rows.length;
    if (rows.length < BATCH_SIZE) break; // fewer than a full page means we're caught up
  }

  console.log(`Done. Categorized ${totalCategorized} transaction(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
