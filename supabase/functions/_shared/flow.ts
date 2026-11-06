// Deno port of classify-flow.js: each transaction's flow_type is 'spend', 'income' or 'transfer'.
// Deterministic, no AI: EXCHANGE (currency conversion) and TOPUP (funding a wallet from your own
// account) are the only codes that reliably mean "not real income"; every other code (TRANSFER
// included, used for P2P payments to friends) follows the direction. Then refunds are paired.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { matchRefunds, type RefundRow, WINDOW_DAYS } from "./refunds.ts";

export const BATCH_SIZE = 200;
const PAGE_SIZE = 1000; // PostgREST caps a response at 1000 rows
const TRANSFER_CODES = new Set(["EXCHANGE", "TOPUP"]);

type FlowRow = { account_uid: string; entry_reference: string; bank_transaction_code?: string | null; credit_debit_indicator: string };

export function resolveFlowType(row: Pick<FlowRow, "bank_transaction_code" | "credit_debit_indicator">) {
  if (TRANSFER_CODES.has(row.bank_transaction_code ?? "")) return "transfer";
  return row.credit_debit_indicator === "DBIT" ? "spend" : "income";
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

export function classifyFlows(db: Db, timeLeft?: () => boolean) {
  return classifyAll<FlowRow>(
    async () => {
      const { data, error } = await db
        .from("transactions")
        .select("entry_reference, account_uid, bank_transaction_code, credit_debit_indicator")
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
          update: { flow_type: resolveFlowType(row) },
          guardColumn: "flow_type",
        })),
      ),
    timeLeft,
  );
}

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
  const guardIn = ["spend", "income"];
  await applyGroupedUpdates(
    db,
    pairs.flatMap(({ debit, credit }) => [
      { ...debit, update: { flow_type: "refunded" }, guardColumn: "flow_type", guardIn },
      { ...credit, update: { flow_type: "refunded", refund_of: debit.entry_reference }, guardColumn: "flow_type", guardIn },
    ]),
  );
  return pairs.length;
}
