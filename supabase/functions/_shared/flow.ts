// Deno port of classify-flow.js: each transaction's flow_type is 'spend', 'income' or 'transfer',
// and flow_source says who decided it. Deterministic, no AI. For a row without a flow, first wins:
// your rule (category_rules.set_flow_type), the Transfer category from your rules or past choices
// (category_source 'rule'), a counterparty that is one of your own accounts, the bank's code
// (EXCHANGE: currency conversion, TOPUP: funding a wallet from your own account; every other code,
// TRANSFER included, is used for P2P payments to friends), then the direction.
// Recent 'default' rows are looked at again: a rule or category that came later (or the Node
// sync filling the flow first) still applies. Rows you decided ('user', 'legacy') are never read.
// Then refunds are paired.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { matchRefunds, type RefundRow, WINDOW_DAYS } from "./refunds.ts";
import { matchRule, type Rule } from "./rules.ts";

export const BATCH_SIZE = 200;
const PAGE_SIZE = 1000; // PostgREST caps a response at 1000 rows
const TRANSFER_CODES = new Set(["EXCHANGE", "TOPUP"]);
const RERESOLVE_DAYS = 90;
const FLOW_COLUMNS =
  "user_id, entry_reference, account_uid, bank_transaction_code, credit_debit_indicator, own_counterparty, creditor_name, remittance_info, category, category_source";

type FlowRow = {
  user_id?: string;
  account_uid: string;
  entry_reference: string;
  bank_transaction_code?: string | null;
  credit_debit_indicator: string;
  own_counterparty?: boolean | null;
  creditor_name?: string | null;
  remittance_info?: string | null;
  category?: string | null;
  category_source?: string | null;
};
export type FlowRule = Rule & { set_flow_type: string };

const direction = (row: Pick<FlowRow, "credit_debit_indicator">) => (row.credit_debit_indicator === "DBIT" ? "spend" : "income");

// A rule's 'spend' or 'income' means "not a transfer": the row keeps its direction.
export function resolveFlow(row: FlowRow, rules: FlowRule[] = []): { flow_type: string; flow_source: string } {
  const rule = rules.find((r) => matchRule(row, r));
  if (rule) return { flow_type: rule.set_flow_type === "transfer" ? "transfer" : direction(row), flow_source: "rule" };
  if (row.category === "Transfer" && row.category_source === "rule") return { flow_type: "transfer", flow_source: "rule" };
  if (row.own_counterparty === true) return { flow_type: "transfer", flow_source: "own_account" };
  if (TRANSFER_CODES.has(row.bank_transaction_code ?? "")) return { flow_type: "transfer", flow_source: "bank" };
  return { flow_type: direction(row), flow_source: "default" };
}

async function fetchFlowRules(db: Db): Promise<FlowRule[]> {
  const { data, error } = await db
    .from("category_rules")
    .select("user_id, match_field, match_text, set_flow_type")
    .not("set_flow_type", "is", null)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

// Classifies batches until none is left or the time is up. The same batch coming back means its
// updates didn't land (applyGroupedUpdates only logs a failure): stop instead of looping.
export async function classifyAll<T extends { account_uid: string; entry_reference: string }>(
  fetchBatch: () => Promise<T[]>,
  applyBatch: (rows: T[]) => Promise<unknown>,
  timeLeft: () => boolean = () => true,
) {
  let total = 0;
  let stuck = false;
  let lastKey = null;
  while (timeLeft()) {
    const rows = await fetchBatch();
    if (rows.length === 0) break;
    const key = rows.map((r) => `${r.account_uid}:${r.entry_reference}`).join();
    if (key === lastKey) {
      console.error(`${rows.length} transaction(s) could not be classified; stopping.`);
      stuck = true;
      break;
    }
    lastKey = key;
    await applyBatch(rows);
    total += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return { total, stuck };
}

// Recent rows that took the direction by default, but where something stronger now applies.
async function reresolveDefaults(db: Db, rules: FlowRule[], timeLeft: () => boolean): Promise<number> {
  if (!timeLeft()) return 0;
  const since = new Date(Date.now() - RERESOLVE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows: FlowRow[] = [];
  // ponytail: 90 days of one person's default rows, a few pages; read first, then update.
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("transactions")
      .select(FLOW_COLUMNS)
      .eq("flow_source", "default")
      .in("flow_type", ["spend", "income"])
      .is("deleted_at", null)
      .gte("booking_date", since)
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  const items = rows
    .map((row) => ({ row, update: resolveFlow(row, rules) }))
    .filter(({ update }) => update.flow_source !== "default")
    .map(({ row, update }) => ({
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update,
      guardColumn: "flow_source",
      guardIn: ["default"],
    }));
  await applyGroupedUpdates(db, items);
  return items.length;
}

export async function classifyFlows(db: Db, timeLeft: () => boolean = () => true) {
  const rules = await fetchFlowRules(db);
  const result = await classifyAll<FlowRow>(
    async () => {
      const { data, error } = await db
        .from("transactions")
        .select(FLOW_COLUMNS)
        .is("flow_type", null)
        .limit(BATCH_SIZE);
      if (error) throw error;
      return data;
    },
    (rows) =>
      applyGroupedUpdates(
        db,
        rows.map((row) => ({
          account_uid: row.account_uid,
          entry_reference: row.entry_reference,
          update: resolveFlow(row, rules),
          guardColumn: "flow_type",
        })),
      ),
    timeLeft,
  );
  return { ...result, reresolved: await reresolveDefaults(db, rules, timeLeft) };
}

// Flows refund pairing may change: the direction by default, a rule's "not a transfer" (it keeps
// the direction), and flows set before flow_source existed (legacy). A flow you set by hand is
// never touched, so moving a wrong pair back to spend sticks.
const REFUND_SOURCES = ["default", "rule", "legacy"];

const REFUND_SINCE = () => new Date(Date.now() - 2 * WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
const keyOf = (r: { account_uid: string; entry_reference: string }) => `${r.account_uid}|${r.entry_reference}`;

// Reads every page of a query in primary-key order (pages never overlap), deduped by key: a write
// from elsewhere during the read can shift a row into the next page.
async function readAll<T extends { account_uid: string; entry_reference: string }>(page: (from: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows = new Map<string, T>();
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await page(from);
    if (error) throw error;
    for (const r of data ?? []) rows.set(keyOf(r), r);
    if ((data ?? []).length < PAGE_SIZE) return [...rows.values()];
  }
}

// Rows still counted as spend/income, recent enough to hold either side of a refund pair.
// ponytail: no time budget inside, fine for one person's 180 days (a few pages); pass timeLeft
// and skip refunds for the run if it ever gets near the 150 s wall clock.
function fetchRefundCandidates(db: Db): Promise<RefundRow[]> {
  return readAll<RefundRow>((from) =>
    db
      .from("transactions")
      .select("entry_reference, account_uid, amount, currency, credit_debit_indicator, creditor_name, remittance_info, booking_date, refund_of")
      .in("flow_type", ["spend", "income"])
      .in("flow_source", REFUND_SOURCES)
      .is("deleted_at", null)
      .gte("booking_date", REFUND_SINCE())
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE_SIZE - 1)
  );
}

type PairSide = { account_uid: string; entry_reference: string; credit_debit_indicator: string; refund_of: string | null; flow_type: string; flow_source: string | null; deleted_at: string | null };
const SIDE_COLUMNS = "account_uid, entry_reference, credit_debit_indicator, refund_of, flow_type, flow_source, deleted_at";

// A pair can end up half applied: one of its two writes failed, or you moved or deleted one side.
// The other side would stay 'refunded' for good (nothing reads 'refunded' rows), off by its amount.
// Credits first: finish the pair when the charge is still plain spend, else count the credit as
// income again, keeping refund_of so it can only re-pair with that same charge (never with last
// month's identical one). Then a charge no live 'refunded' credit points to counts as spend again,
// and pairs anew below. Only rows in REFUND_SOURCES change; the window is safe for charges since
// their refund lands after them, and a credit looks its charge up by key, with no date limit.
async function repairHalfPairs(db: Db): Promise<number> {
  const refunded = await readAll<PairSide>((from) =>
    db
      .from("transactions")
      .select(SIDE_COLUMNS)
      .eq("flow_type", "refunded")
      .is("deleted_at", null)
      .gte("booking_date", REFUND_SINCE())
      .order("account_uid")
      .order("entry_reference")
      .range(from, from + PAGE_SIZE - 1)
  );
  const credits = refunded.filter((r) => r.credit_debit_indicator === "CRDT");
  const charges = new Map<string, PairSide>();
  const byAccount = new Map<string, string[]>();
  for (const c of credits) if (c.refund_of) byAccount.set(c.account_uid, [...(byAccount.get(c.account_uid) ?? []), c.refund_of]);
  for (const [account_uid, refs] of byAccount) {
    for (let i = 0; i < refs.length; i += 50) {
      const { data, error } = await db.from("transactions").select(SIDE_COLUMNS).eq("account_uid", account_uid).in("entry_reference", refs.slice(i, i + 50));
      if (error) throw error;
      for (const r of data as PairSide[]) charges.set(keyOf(r), r);
    }
  }

  const fixable = (r: PairSide) => REFUND_SOURCES.includes(r.flow_source ?? "");
  const items = [];
  const liveCredits = new Set<string>(); // "account|charge ref" of credits still paired
  for (const c of credits) {
    const charge = c.refund_of ? charges.get(keyOf({ account_uid: c.account_uid, entry_reference: c.refund_of })) : undefined;
    const live = charge && !charge.deleted_at;
    if (live && charge.flow_type === "refunded") liveCredits.add(keyOf(charge));
    else if (live && charge.flow_type === "spend" && fixable(charge)) {
      liveCredits.add(keyOf(charge));
      items.push({ ...charge, update: { flow_type: "refunded" }, guardColumn: "flow_source", guardIn: REFUND_SOURCES, alsoIn: ["flow_type", ["spend"]] as [string, string[]] });
    } else if (fixable(c)) {
      items.push({ ...c, update: { flow_type: "income" }, guardColumn: "flow_source", guardIn: REFUND_SOURCES, alsoIn: ["flow_type", ["refunded"]] as [string, string[]] });
    }
  }
  for (const d of refunded) {
    if (d.credit_debit_indicator !== "DBIT" || liveCredits.has(keyOf(d)) || !fixable(d)) continue;
    items.push({ ...d, update: { flow_type: "spend" }, guardColumn: "flow_source", guardIn: REFUND_SOURCES, alsoIn: ["flow_type", ["refunded"]] as [string, string[]] });
  }
  return await applyGroupedUpdates(db, items);
}

// Both sides of a pair become 'refunded' (excluded from spend and income); the credit remembers
// which charge it reverses. failed counts update statements that errored (they are only logged).
export async function markRefunds(db: Db): Promise<{ pairs: number; failed: number }> {
  let failed = await repairHalfPairs(db);
  const pairs = matchRefunds(await fetchRefundCandidates(db));
  // Both guards: a flow you set, or a rule that made the row a transfer, since the read wins.
  const guard = { guardColumn: "flow_source", guardIn: REFUND_SOURCES, alsoIn: ["flow_type", ["spend", "income"]] as [string, string[]] };
  failed += await applyGroupedUpdates(
    db,
    pairs.flatMap(({ debit, credit }) => [
      { ...debit, update: { flow_type: "refunded" }, ...guard },
      { ...credit, update: { flow_type: "refunded", refund_of: debit.entry_reference }, ...guard },
    ]),
  );
  return { pairs: pairs.length, failed };
}
