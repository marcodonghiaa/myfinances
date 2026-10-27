// Pick which stored bank account an Enable Banking account maps to.
// identification_hash covers IBAN + currency, so it is unique per Revolut
// currency pocket. IBAN alone is shared by every pocket, so it is only
// trusted together with currency.

import type { BankInfo } from "./bank-info.ts";

export interface StoredAccount { uid: string; iban: string | null; currency: string; identification_hash: string | null }
export type IncomingAccount = Omit<StoredAccount, "uid">;

export function matchAccount(existing: StoredAccount[], incoming: IncomingAccount): string | null {
  const { iban, currency, identification_hash: hash } = incoming;
  const byHash = hash ? existing.find((s) => s.identification_hash === hash) : undefined;
  if (byHash) return byHash.uid;
  const byIban = iban ? existing.find((s) => s.iban === iban && s.currency === currency) : undefined;
  return byIban?.uid ?? null;
}

// Update for a matched row. eb_account_uid follows the current session (EB ids
// die with their session); iban, hash, label and bank fields only overwrite when the bank sends them.
export function matchPatch(
  incoming: IncomingAccount & { label: string | null },
  ebUid: string,
  consentValidUntil: string | null,
  bank: BankInfo,
): Record<string, unknown> {
  const { iban, currency, identification_hash, label } = incoming;
  const { bank_name, bank_country, bank_logo } = bank;
  return {
    eb_account_uid: ebUid,
    consent_valid_until: consentValidUntil,
    currency,
    ...(iban !== null && { iban }),
    ...(identification_hash !== null && { identification_hash }),
    ...(label !== null && { label }),
    ...(bank_name !== null && { bank_name }),
    ...(bank_country !== null && { bank_country }),
    ...(bank_logo !== null && { bank_logo }),
  };
}
