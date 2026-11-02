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

// The rate for one currency, plus the rows to store, when fx_rates has none yet. Null when the code
// is not a plain currency (Yahoo also returns subunits like ZAc) or Frankfurter has no such rate.
// Throws on a bad response, like latestFxRows.
export async function fetchRateToEur(currency: string) {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const rows = await latestFxRows([currency]);
  const rate = rows.find((r) => r.currency === currency)?.rate_to_eur;
  return rate === undefined ? null : { rate, rows };
}
