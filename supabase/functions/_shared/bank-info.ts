// The bank (ASPSP) behind a linked account. Enable Banking's /sessions response
// names the bank and its country but not its logo; /aspsps?country= lists logos.

export interface BankInfo { bank_name: string | null; bank_country: string | null; bank_logo: string | null }

export function bankLogo(aspsps: Array<{ name: string; logo?: string | null }> | null, name: string): string | null {
  return aspsps?.find((a) => a.name === name)?.logo ?? null;
}
