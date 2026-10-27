// What the callback found, for the dashboard toast ("Revolut: EUR, GBP, USD").
// Bank name and currency codes only: the redirect URL must carry no personal data.

export function linkedParams(count: number, bankName: string | null, currencies: string[]): Record<string, string> {
  const params: Record<string, string> = { bank_linked: String(count) };
  if (bankName !== null) params.bank = bankName;
  const codes = [...new Set(currencies)].sort();
  if (codes.length > 0) params.currencies = codes.join(",");
  return params;
}
