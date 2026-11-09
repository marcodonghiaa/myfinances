// Detects recurring streams (subscriptions) in one user's charges. Pure: rows feed upsert_detected_streams.
import { isTransferCode } from "./classify-type.ts";
import { AGGREGATORS } from "./merchant-key.ts";

export type Charge = {
  account_uid: string | null;
  merchant_key: string | null;
  currency: string;
  amount: number;
  amount_eur: number | null;
  booking_date: string;
  category: string | null;
  custom_name: string | null;
  creditor_name: string | null;
  bank_transaction_code: string | null;
  flow_type: string | null;
  credit_debit_indicator: string;
  deleted_at: string | null;
  transaction_type?: string | null;
};

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export type DetectedStream = {
  stream_key: string;
  merchant_key: string;
  account_uid: string | null;
  currency: string;
  display_name: string | null;
  category: string | null;
  cadence: Cadence | null;
  typical_amount: number;
  typical_amount_eur: number | null;
  charge_count: number;
  first_charged: string;
  last_charged: string;
  next_expected: string | null;
  detected_status: "suggested" | "active";
  is_direct_debit: boolean;
};

const EXCLUDED_CATEGORIES = new Set(["Transfer", "Taxes", "Income"]);
// [cadence, period days, tolerance days]
const CADENCES: [Cadence, number, number][] = [["weekly", 7, 2], ["monthly", 30, 4], ["quarterly", 91, 10], [
  "yearly",
  365,
  21,
]];
const DAY = 86_400_000;
// The AI "Subscription" tag alone proposes a stream, only if charged within this many days (spec: Gemini shortcut).
const TAG_RECENT_DAYS = 400;

const toDays = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;
const fromDays = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Ruling 4: every interval fits P±t at some multiple k≤3 (one misfit allowed with 4+ intervals); closest period wins.
function pickCadence(gaps: number[]): [Cadence, number] | null {
  const med = median(gaps);
  const fits = CADENCES.filter(([, p, t]) =>
    gaps.filter((g) => ![1, 2, 3].some((k) => Math.abs(g - k * p) <= k * t)).length <= (gaps.length >= 4 ? 1 : 0)
  ).sort((a, b) => Math.abs(a[1] - med) - Math.abs(b[1] - med));
  return fits.length ? [fits[0][0], fits[0][1]] : null;
}

// Calendar month: same day of month, clamped to the target month's last day.
function addMonth(d: string): string {
  const y = +d.slice(0, 4), m = +d.slice(5, 7); // m is 1-based, so it is next month's 0-based index
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(+d.slice(8, 10), last))).toISOString().slice(0, 10);
}

// Ruling 3: normal keys keep charges within ±10% of the median; aggregators split greedily by amount.
function clusters(group: Charge[], aggregator: boolean): Charge[][] {
  if (!aggregator) {
    const med = median(group.map((c) => c.amount));
    return [group.filter((c) => Math.abs(c.amount - med) <= med * 0.1)];
  }
  const out: Charge[][] = [];
  for (const c of [...group].sort((a, b) => a.amount - b.amount)) {
    const cur = out[out.length - 1];
    if (cur && c.amount <= cur[0].amount * 1.1) cur.push(c);
    else out.push([c]);
  }
  return out;
}

export function detectStreams(charges: Charge[], today: string): DetectedStream[] {
  const groups = new Map<string, Charge[]>();
  for (const c of charges) {
    if (
      c.credit_debit_indicator !== "DBIT" || c.flow_type !== "spend" || c.deleted_at !== null ||
      c.merchant_key === null || EXCLUDED_CATEGORIES.has(c.category ?? "") ||
      isTransferCode(c.bank_transaction_code) || c.booking_date > today
    ) continue;
    const key = `${c.merchant_key}|${c.account_uid}|${c.currency}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(c);
  }

  const out: DetectedStream[] = [];
  for (const [groupKey, group] of groups) {
    const aggregator = (AGGREGATORS as readonly string[]).includes(group[0].merchant_key!);
    for (const cluster of clusters(group, aggregator)) {
      const sorted = [...cluster].sort((a, b) => a.booking_date.localeCompare(b.booking_date));
      const newest = sorted[sorted.length - 1];
      // Same-day duplicates count as charges but not as intervals.
      const days = [...new Set(sorted.map((c) => toDays(c.booking_date)))];
      const picked = days.length >= 2 ? pickCadence(days.slice(1).map((d, i) => d - days[i])) : null;
      // No rhythm: the AI tag still proposes it (suggested, cadence unknown) when it is recent.
      const tagged = cluster.some((c) => c.transaction_type === "Subscription") &&
        toDays(today) - toDays(newest.booking_date) <= TAG_RECENT_DAYS;
      if (!picked && !tagged) continue;
      const [cadence, period] = picked ?? [null, null];
      const typical = median(cluster.map((c) => c.amount));
      const isDirectDebit = cluster.some((c) => /sdd/i.test(c.bank_transaction_code ?? ""));
      out.push({
        // The anchor (cluster minimum) stays put when the price rises; the median would drift run to run.
        stream_key: aggregator ? `${groupKey}|${Math.min(...cluster.map((c) => c.amount)).toFixed(2)}` : groupKey,
        merchant_key: newest.merchant_key!,
        account_uid: newest.account_uid,
        currency: newest.currency,
        display_name: newest.custom_name || newest.creditor_name,
        category: newest.category,
        cadence,
        typical_amount: typical,
        typical_amount_eur: newest.amount_eur,
        charge_count: cluster.length,
        first_charged: sorted[0].booking_date,
        last_charged: newest.booking_date,
        next_expected: cadence === "monthly"
          ? addMonth(newest.booking_date)
          : period === null
          ? null
          : fromDays(toDays(newest.booking_date) + period),
        // Rulings 1 and 5: weekly and SDD streams are never auto-active; nor is one without a rhythm.
        detected_status: cluster.length >= 3 && cadence !== null && cadence !== "weekly" && !isDirectDebit
          ? "active"
          : "suggested",
        is_direct_debit: isDirectDebit,
      });
    }
  }
  return out;
}
