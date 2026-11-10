// Money moved between two of your own accounts shows up twice: a debit on one, the same amount
// credited on the other. Banks often send no IBAN to recognise it (own_counterparty), so this
// step pairs the two sides and marks both as a suggested transfer (flow_source 'pair') that you
// confirm or reject in the dashboard (resolve_transfer_pair). Only rows whose flow came from the
// bank code or the direction are candidates: yours, your rules' and your own-account ones stay.
// Better no pair than a wrong one: any tie skips the rows involved.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { errorTag } from "./log-safe.ts";

export const PAIR_WINDOW_DAYS = 4;
const LOOKBACK_DAYS = 90;
const DAY_MS = 86_400_000;
const PAGE = 1000;

export interface PairRow {
  user_id: string;
  account_uid: string;
  entry_reference: string;
  amount: number;
  currency: string;
  credit_debit_indicator: string;
  booking_date: string;
}
export type Pair = { out: PairRow; in: PairRow };

const sideKey = (r: { account_uid: string; entry_reference: string }) => `${r.account_uid}:${r.entry_reference}`;
export const pairKey = (out: PairRow, inn: PairRow) => `${sideKey(out)}>${sideKey(inn)}`;

const days = (a: PairRow, b: PairRow) => Math.abs(Date.parse(a.booking_date) - Date.parse(b.booking_date)) / DAY_MS;

const matches = (d: PairRow, c: PairRow) =>
  d.user_id === c.user_id &&
  d.account_uid !== c.account_uid &&
  d.currency === c.currency &&
  Number(d.amount) === Number(c.amount) &&
  days(d, c) <= PAIR_WINDOW_DAYS;

// One-to-one: a debit and a credit pair when each is the other's single closest match. A row whose
// closest matches tie is ambiguous: neither it nor those matches are paired. Rows left after a
// round are looked at again without the rows already decided.
// rejectedKeys: pairKey of pairs you rejected, never proposed again.
export function matchTransferPairs(rows: PairRow[], rejectedKeys: Set<string> = new Set()): Pair[] {
  const debits = rows.filter((r) => r.credit_debit_indicator === "DBIT");
  const credits = rows.filter((r) => r.credit_debit_indicator === "CRDT");
  let edges = debits.flatMap((d) =>
    credits.filter((c) => matches(d, c) && !rejectedKeys.has(pairKey(d, c))).map((c) => ({ d, c, dist: days(d, c) }))
  );
  const pairs: Pair[] = [];
  while (edges.length > 0) {
    // Each row's closest distance and how many matches share it.
    const best = new Map<PairRow, { dist: number; n: number }>();
    for (const e of edges) {
      for (const r of [e.d, e.c]) {
        const b = best.get(r);
        if (!b || e.dist < b.dist) best.set(r, { dist: e.dist, n: 1 });
        else if (e.dist === b.dist) b.n++;
      }
    }
    // A tie skips the row and every match it ties between, for good.
    const done = new Set<PairRow>();
    for (const e of edges) {
      for (const [r, other] of [[e.d, e.c], [e.c, e.d]]) {
        const b = best.get(r)!;
        if (b.n > 1 && e.dist === b.dist) done.add(r).add(other);
      }
    }
    for (const e of edges) {
      const bd = best.get(e.d)!, bc = best.get(e.c)!;
      if (bd.n === 1 && bc.n === 1 && e.dist === bd.dist && e.dist === bc.dist) {
        pairs.push({ out: e.d, in: e.c });
        done.add(e.d).add(e.c);
      }
    }
    if (done.size === 0) break;
    edges = edges.filter((e) => !done.has(e.d) && !done.has(e.c));
  }
  return pairs;
}

async function fetchCandidates(db: Db): Promise<PairRow[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows: PairRow[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await db
      .from("transactions")
      .select("user_id, account_uid, entry_reference, amount, currency, credit_debit_indicator, booking_date")
      .in("flow_type", ["spend", "income"])
      .in("flow_source", ["default", "bank"])
      .is("deleted_at", null)
      .gte("booking_date", since)
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

type PairRecord = { out_account_uid: string; out_ref: string; in_account_uid: string; in_ref: string; status: string };

// ponytail: reads every pair ever made; a handful per month for one person.
async function fetchPairs(db: Db): Promise<PairRecord[]> {
  const pairs: PairRecord[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await db
      .from("transfer_pairs")
      .select("out_account_uid, out_ref, in_account_uid, in_ref, status")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    pairs.push(...data);
    if (data.length < PAGE) return pairs;
  }
}

// Pairs this run's candidates and marks both sides. Returns how many pairs were suggested.
export async function pairTransfers(db: Db, timeLeft: () => boolean = () => true): Promise<number> {
  if (!timeLeft()) return 0;
  const existing = await fetchPairs(db);
  const taken = new Set<string>();
  const rejected = new Set<string>();
  for (const p of existing) {
    const out = { account_uid: p.out_account_uid, entry_reference: p.out_ref };
    const inn = { account_uid: p.in_account_uid, entry_reference: p.in_ref };
    if (p.status === "rejected") rejected.add(`${sideKey(out)}>${sideKey(inn)}`);
    else taken.add(sideKey(out)).add(sideKey(inn));
  }
  const candidates = (await fetchCandidates(db)).filter((r) => !taken.has(sideKey(r)));
  const marked: Pair[] = [];
  for (const pair of matchTransferPairs(candidates, rejected)) {
    // One insert per pair: a side another run just paired fails alone (unique index).
    const { error } = await db.from("transfer_pairs").insert({
      user_id: pair.out.user_id,
      out_account_uid: pair.out.account_uid,
      out_ref: pair.out.entry_reference,
      in_account_uid: pair.in.account_uid,
      in_ref: pair.in.entry_reference,
      status: "suggested",
    });
    if (error) console.error(`Transfer pair not saved: ${errorTag(error)}`);
    else marked.push(pair);
  }
  await applyGroupedUpdates(
    db,
    marked.flatMap((p) =>
      [p.out, p.in].map((r) => ({
        account_uid: r.account_uid,
        entry_reference: r.entry_reference,
        update: { flow_type: "transfer", flow_source: "pair" },
        guardColumn: "flow_source",
        guardIn: ["default", "bank"],
      }))
    ),
  );
  return marked.length;
}
