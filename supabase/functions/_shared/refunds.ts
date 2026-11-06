// Deno port of refunds.js. Pairs each incoming refund with the earlier charge it reverses, so
// neither counts as spend or income. Match key: same account, merchant, amount and currency;
// the credit must land 0-90 days after the debit. Full refunds only -- partial ones are marked
// by hand in the dashboard.
export const WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export interface RefundRow {
  account_uid: string;
  entry_reference: string;
  amount: number;
  currency: string;
  credit_debit_indicator: string;
  creditor_name?: string | null;
  remittance_info?: string | null;
  booking_date: string;
}

type Ref = { account_uid: string; entry_reference: string };

// debtor_name is the account holder on card refunds, so it never identifies the merchant.
// Banks put the merchant in the remittance instead: "Refund from <merchant>".
const REFUND_FROM = /^refund from\s+/i;
const normalize = (name?: string | null) => (name || "").trim().replace(/\s+/g, " ").toLowerCase();
// A refund names its merchant in the remittance; creditor_name can be the account holder there.
// A card charge without a creditor_name carries "Merchant*CITY" in its remittance.
const merchantOf = (r: RefundRow) => {
  const remittance = (r.remittance_info || "").trim();
  if (REFUND_FROM.test(remittance)) return normalize(remittance.replace(REFUND_FROM, ""));
  if (r.creditor_name) return normalize(r.creditor_name);
  return r.credit_debit_indicator === "DBIT" ? normalize(remittance.split("*")[0]) : "";
};
const dayOf = (r: RefundRow) => Date.parse(r.booking_date);
const ref = (r: RefundRow): Ref => ({ account_uid: r.account_uid, entry_reference: r.entry_reference });

export function matchRefunds(rows: RefundRow[]): Array<{ debit: Ref; credit: Ref }> {
  const byDate = (a: RefundRow, b: RefundRow) => dayOf(a) - dayOf(b);
  const debits = rows.filter((r) => r.credit_debit_indicator === "DBIT" && merchantOf(r)).sort(byDate);
  const credits = rows.filter((r) => r.credit_debit_indicator === "CRDT" && merchantOf(r)).sort(byDate);
  const used = new Set<RefundRow>();
  const pairs = [];

  for (const credit of credits) {
    const debit = debits.findLast(
      (d) =>
        !used.has(d) &&
        d.account_uid === credit.account_uid &&
        d.currency === credit.currency &&
        d.amount === credit.amount &&
        merchantOf(d) === merchantOf(credit) &&
        dayOf(d) <= dayOf(credit) &&
        dayOf(credit) - dayOf(d) <= WINDOW_DAYS * DAY_MS,
    );
    if (!debit) continue;
    used.add(debit);
    pairs.push({ debit: ref(debit), credit: ref(credit) });
  }
  return pairs;
}
