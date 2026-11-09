// What a bank link found, for the dashboard toast ("Revolut: EUR, GBP, USD"), in
// complete-bank-consent's reply. Bank name and currency codes only: no personal data.

export function linkedParams(count: number, bankName: string | null, currencies: string[]): Record<string, string> {
  const params: Record<string, string> = { bank_linked: String(count) };
  if (bankName !== null) params.bank = bankName;
  const codes = [...new Set(currencies)].sort();
  if (codes.length > 0) params.currencies = codes.join(",");
  return params;
}
