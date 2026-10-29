// Same row shape as toRows in fx-sync.js (rate_to_eur = 1 / units per EUR, plus an EUR row).
export function fxRows(date: string, rates: Record<string, number>) {
  const rows = [{ date, currency: "EUR", rate_to_eur: 1 }];
  for (const [currency, unitsPerEur] of Object.entries(rates)) {
    rows.push({ date, currency, rate_to_eur: 1 / unitsPerEur });
  }
  return rows;
}

// Latest Frankfurter rates for the non-EUR currencies, or [] when there is nothing to fetch.
// Throws on a bad response; callers treat that as best-effort.
export async function latestFxRows(currencies: string[]) {
  const symbols = [...new Set(currencies.filter((c) => c !== "EUR"))];
  if (symbols.length === 0) return [];
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${symbols.join(",")}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Frankfurter API error ${res.status}`);
  const data = await res.json();
  return fxRows(data.date, data.rates);
}
