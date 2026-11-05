const { UNTRUSTED_TEXT_NOTE } = require('./gemini-classify');
const { CATEGORIES, guideFor } = require('./categories');

// The Gemini prompt for categorize.js, kept apart so it can be tested without a network
// or database. debtor_name is the payer: on an incoming credit, creditor_name is usually
// empty or the account holder, so without the payer the model only sees the note.
// categories: this user's list (built-in minus hidden, plus their own), see categoriesFor.
function buildCategorizePrompt(rows, categories = CATEGORIES) {
  return `You are categorizing personal bank transactions into exactly one of these categories: ${categories.join(', ')}.

Category guide:
${guideFor(categories)}

Base your judgement on creditor_name, debtor_name and remittance_info — merchant/reference text that may be messy, abbreviated, or in a foreign language. creditor_name is who received the money; debtor_name is who paid it. This matters especially for P2P/bank transfers to a person: creditor_name alone (a person's name) tells you nothing, but remittance_info often does — e.g. a transfer to a friend with remittance_info mentioning "spotify" or "netflix" should be categorized by that actual purpose (the category that fits streaming), not filed under Transfer just because the payment method was a person-to-person transfer. Only use Transfer when nothing in remittance_info indicates a real purpose.

Incoming payments (direction CRDT) are Income, Transfer, or a refund/pay-back of a spending category. Only file a CRDT under a spending category when remittance_info clearly names that purpose and the amount is plausible for it, e.g. a friend paying back a share of a subscription. A large incoming amount (hundreds or thousands) from a person or from the account holder's own other account is Transfer unless it looks like salary/earnings (Income).

${UNTRUSTED_TEXT_NOTE}

Transactions (JSON array):
${JSON.stringify(rows.map((r) => ({
  entry_reference: r.entry_reference,
  creditor_name: r.creditor_name,
  debtor_name: r.debtor_name,
  remittance_info: r.remittance_info,
  amount: r.amount,
  currency: r.currency,
  direction: r.credit_debit_indicator,
})), null, 2)}

Return a JSON array of {"entry_reference": string, "category": string} for every transaction above, same order, one entry each. category must be exactly one of the allowed categories.`;
}

module.exports = { buildCategorizePrompt };
