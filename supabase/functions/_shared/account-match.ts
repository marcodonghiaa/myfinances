// Pick which stored bank account an Enable Banking account maps to.
// identification_hash covers IBAN + currency, so it is unique per Revolut
// currency pocket. IBAN alone is shared by every pocket, so it is only
// trusted together with currency.

export interface StoredAccount { uid: string; iban: string | null; currency: string; identification_hash: string | null }
export type IncomingAccount = Omit<StoredAccount, "uid">;

export function matchAccount(existing: StoredAccount[], incoming: IncomingAccount): string | null {
  const { iban, currency, identification_hash: hash } = incoming;
  const byHash = hash ? existing.find((s) => s.identification_hash === hash) : undefined;
  if (byHash) return byHash.uid;
  const byIban = iban ? existing.find((s) => s.iban === iban && s.currency === currency) : undefined;
  return byIban?.uid ?? null;
}
