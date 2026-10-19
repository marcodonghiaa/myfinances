const { CATEGORIES, guideFor } = require('./categories');
const { UNTRUSTED_TEXT_NOTE } = require('./gemini-classify');

// A Splitwise share is shared everyday spending, so income, transfer and tax buckets are not offered.
const NOT_SHARED = new Set(['Income', 'Transfer', 'Taxes']);
const SPLITWISE_CATEGORIES = CATEGORIES.filter((c) => !NOT_SHARED.has(c));

// Friends write the descriptions, so only id and description leave the server: no amounts,
// group name or user, and the model is told the text is untrusted.
function buildPrompt(rows) {
  return `You are categorizing shared household and trip expenses from a Splitwise group into exactly one of these categories: ${SPLITWISE_CATEGORIES.join(', ')}.

Category guide:
${guideFor(SPLITWISE_CATEGORIES)}

Descriptions are short, informal, often Italian or English, and may be a store name, a nickname or a person's name. Typical cases: Target, Trader Joe's ("tj"), "spesa" and grocery runs are Groceries; paper towels, soap, detergent pods, filters, toilet paper and other home supplies are Housing; Uber, Lyft, Waymo and bike rentals are Transports; use Others when the description gives no hint (for example only a person's name).

${UNTRUSTED_TEXT_NOTE}

Expenses (JSON array):
${JSON.stringify(rows.map((r) => ({ entry_reference: r.id, description: r.description })), null, 2)}

Return a JSON array of {"entry_reference": string, "category": string} for every expense above, same order, one entry each. category must be exactly one of the allowed categories.`;
}

// Keeps one valid answer per row we sent; anything else the model returned is ignored.
function planUpdates(results, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set();
  const plan = [];
  for (const { entry_reference, category } of results) {
    const row = byId.get(entry_reference);
    if (!row || seen.has(entry_reference)) continue;
    if (!SPLITWISE_CATEGORIES.includes(category)) {
      console.warn(`Skipping invalid category "${category}" for ${entry_reference}`);
      continue;
    }
    seen.add(entry_reference);
    plan.push({ id: row.id, user_id: row.user_id, category });
  }
  return plan;
}

module.exports = { SPLITWISE_CATEGORIES, buildPrompt, planUpdates };
