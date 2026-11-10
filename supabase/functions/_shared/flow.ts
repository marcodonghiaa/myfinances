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
  applyBatch: (rows: T[]) => Promise<void>,
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

// Flows refund pairing may change: the direction by default, and flows set before flow_source
// existed (legacy, also what this pairing always read). A flow you or a rule decided is never
// touched, so moving a wrong pair back to spend sticks.
const REFUND_SOURCES = ["default", "legacy"];

// Rows still counted as spend/income, recent enough to hold either side of a refund pair.
// ponytail: no time budget inside, fine for one person's 180 days (a few pages); pass timeLeft
// and skip refunds for the run if it ever gets near the 150 s wall clock.
async function fetchRefundCandidates(db: Db): Promise<RefundRow[]> {
  const since = new Date(Date.now() - 2 * WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows: RefundRow[] = [];
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("transactions")
      .select("entry_reference, account_uid, amount, currency, credit_debit_indicator, creditor_name, remittance_info, booking_date")
      .in("flow_type", ["spend", "income"])
      .in("flow_source", REFUND_SOURCES)
      .is("deleted_at", null)
      .gte("booking_date", since)
      .order("entry_reference")
      .order("account_uid") // the key is (account_uid, entry_reference): pages must not overlap
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

// Both sides of a pair become 'refunded' (excluded from spend and income); the credit remembers
// which charge it reverses.
export async function markRefunds(db: Db): Promise<number> {
  const pairs = matchRefunds(await fetchRefundCandidates(db));
  const guardIn = REFUND_SOURCES; // flow_source: a later decision by you or a rule wins
  await applyGroupedUpdates(
    db,
    pairs.flatMap(({ debit, credit }) => [
      { ...debit, update: { flow_type: "refunded" }, guardColumn: "flow_source", guardIn },
      { ...credit, update: { flow_type: "refunded", refund_of: debit.entry_reference }, guardColumn: "flow_source", guardIn },
    ]),
  );
  return pairs.length;
}
