// The 12 spending categories and what each one means, shared by every categorizer.
const CATEGORIES = [
  'Shopping', 'Entertainment', 'Groceries', 'Dine Out', 'Services', 'Housing',
  'Transports', 'Experiences', 'Income', 'Health', 'Transfer', 'Others',
];

// One line per category, keyed by name so a caller can leave some out.
const CATEGORY_GUIDE = {
  Shopping: 'clothes, tech purchases (phones, laptops, electronics), Amazon, general retail.',
  Entertainment: 'video games, streaming (Netflix, Spotify), movies, hobbies.',
  Groceries: 'supermarkets, grocery delivery.',
  'Dine Out': 'restaurants, cafes, bars, takeout, drinks out.',
  Services: 'mobile/phone plans, internet, insurance, professional services, non-entertainment software/cloud subscriptions (e.g. AI tools, cloud storage).',
  Housing: 'rent, mortgage, utilities (electricity, water, gas bill for the home).',
  Transports: 'bus, car/gas, trains, flights, commuting and transport of any kind.',
  Experiences: 'hotels, events, concerts, tickets, activities while traveling or out.',
  Income: 'incoming payments (credit_debit_indicator CRDT) that look like salary/earnings.',
  Health: 'pharmacy, doctor, gym, fitness, medical expenses.',
  Transfer: 'account-to-account or P2P transfers with no indicated purpose (e.g. splitting rent, paying someone back with no note).',
  Others: 'only if nothing else plausibly fits.',
};

function guideFor(categories) {
  return categories.map((c) => `- ${c}: ${CATEGORY_GUIDE[c]}`).join('\n');
}

module.exports = { CATEGORIES, guideFor };
