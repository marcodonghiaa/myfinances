// Deno port of categories.js: the built-in spending categories and what each one means.
export const CATEGORIES = [
  "Shopping", "Entertainment", "Groceries", "Dine Out", "Services", "Housing",
  "Transports", "Experiences", "Income", "Health", "Transfer", "Taxes", "Others",
];

// One line per category, keyed by name so a caller can leave some out.
const CATEGORY_GUIDE: Record<string, string> = {
  Shopping: "clothes, tech purchases (phones, laptops, electronics), Amazon, general retail.",
  Entertainment: "video games, streaming (Netflix, Spotify), movies, hobbies.",
  Groceries: "supermarkets, grocery delivery.",
  "Dine Out": "restaurants, cafes, bars, takeout, drinks out.",
  Services: "mobile/phone plans, internet, insurance, professional services, non-entertainment software/cloud subscriptions (e.g. AI tools, cloud storage).",
  Housing: "rent, mortgage, utilities (electricity, water, gas bill for the home).",
  Transports: "bus, car/gas, trains, flights, commuting and transport of any kind.",
  Experiences: "hotels, events, concerts, tickets, activities while traveling or out.",
  Income: "incoming payments (credit_debit_indicator CRDT) that look like salary/earnings.",
  Health: "pharmacy, doctor, gym, fitness, medical expenses.",
  Transfer: "account-to-account or P2P transfers with no indicated purpose (e.g. splitting rent, paying someone back with no note).",
  Taxes: "tax payments: F24, Agenzia delle Entrate, income tax and VAT (IVA) for a self-employed business, social contributions (INPS), tax on investments or capital gains, IRS/HMRC and other government tax bodies.",
  Others: "only if nothing else plausibly fits.",
};

export function guideFor(categories: string[]): string {
  return categories
    .map((c) => `- ${c}: ${CATEGORY_GUIDE[c] ?? "a category the user created; use it when the name fits."}`)
    .join("\n");
}

// One user's list: the built-in categories minus the ones they hid, plus their own.
export function categoriesFor(rows: Array<{ name: string; hidden: boolean }>): string[] {
  const hidden = new Set(rows.filter((r) => r.hidden).map((r) => r.name));
  const own = rows.filter((r) => !r.hidden && !CATEGORIES.includes(r.name)).map((r) => r.name);
  return [...CATEGORIES.filter((c) => !hidden.has(c)), ...own];
}
