// Classifies each transaction's flow_type: 'spend', 'income', or 'transfer'.
// Deterministic only, no AI call -- the bank's own transaction code already
// says everything needed. Confirmed against real data: EXCHANGE (currency
// conversion) and TOPUP (self-funding a wallet from your own other account)
// are the only two codes that reliably mean "not real income", and every
// other code (including TRANSFER, used for regular P2P payments to friends)
// stays as ordinary spend/income.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { applyGroupedUpdates } = require('./batch-update');
const { matchRefunds, WINDOW_DAYS } = require('./refunds');
const { errorTag } = require('./log-safe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const BATCH_SIZE = 200;

const TRANSFER_CODES = new Set(['EXCHANGE', 'TOPUP']);

// A Transfer category from your rules or past choices (category_source 'rule') is a transfer.
const learnedTransfer = (row) => row.category === 'Transfer' && row.category_source === 'rule';

function resolveFlowType(row) {
  if (learnedTransfer(row) || TRANSFER_CODES.has(row.bank_transaction_code)) return 'transfer';
  return row.credit_debit_indicator === 'DBIT' ? 'spend' : 'income';
}

// Who decided it (transactions.flow_source). The Edge Function post-sync also applies your flow
// rules, own accounts and transfer pairs, re-resolving recent 'default' rows.
function flowSourceFor(row) {
  if (learnedTransfer(row)) return 'rule';
  return TRANSFER_CODES.has(row.bank_transaction_code) ? 'bank' : 'default';
}

async function fetchUnclassified() {
  const { data, error } = await supabase
    .from('transactions')
    .select('entry_reference, account_uid, bank_transaction_code, credit_debit_indicator, category, category_source')
    .is('flow_type', null)
    .limit(BATCH_SIZE);
  if (error) throw error;
  return data;
}

const PAGE_SIZE = 1000; // PostgREST caps a response at 1000 rows

// Flows refund pairing may change: the direction by default, a rule's "not a transfer" (it keeps
// the direction), and flows set before flow_source existed (legacy). A flow you set by hand is
// never touched, so moving a wrong pair back to spend sticks.
const REFUND_SOURCES = ['default', 'rule', 'legacy'];

// Rows still counted as spend/income, recent enough to hold either side of a refund pair.
async function fetchRefundCandidates(db) {
  const since = new Date(Date.now() - 2 * WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('transactions')
      .select('entry_reference, account_uid, amount, currency, credit_debit_indicator, creditor_name, remittance_info, booking_date')
      .in('flow_type', ['spend', 'income'])
      .in('flow_source', REFUND_SOURCES)
      .is('deleted_at', null)
      .gte('booking_date', since)
      .order('entry_reference')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

// Both sides of a pair become 'refunded' (excluded from spend and income); the
// credit remembers which charge it reverses.
async function markRefunds(db = supabase) {
  const pairs = matchRefunds(await fetchRefundCandidates(db));
  // Both guards: a flow you set, or a rule that made the row a transfer, since the read wins.
  const guard = { guardColumn: 'flow_source', guardIn: REFUND_SOURCES, alsoIn: ['flow_type', ['spend', 'income']] };
  await applyGroupedUpdates(
    db,
    pairs.flatMap(({ debit, credit }) => [
      { ...debit, update: { flow_type: 'refunded' }, ...guard },
      { ...credit, update: { flow_type: 'refunded', refund_of: debit.entry_reference }, ...guard },
    ]),
  );
  return pairs.length;
}

// Classifies batches until none is left. The same batch coming back means its updates didn't
// land (applyGroupedUpdates only logs a failure): stop instead of looping until the job is
// killed, which would also hold the launchd lock and skip every later sync.
async function classifyAll(fetchBatch, applyBatch) {
  let total = 0;
  let lastKey = null;
  while (true) {
    const rows = await fetchBatch();
    if (rows.length === 0) break;
    const key = rows.map((r) => `${r.account_uid}:${r.entry_reference}`).join();
    if (key === lastKey) {
      console.error(`${rows.length} transaction(s) could not be classified; stopping.`);
      process.exitCode = 1;
      break;
    }
    lastKey = key;
    await applyBatch(rows);
    total += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function main() {
  const totalClassified = await classifyAll(fetchUnclassified, (rows) =>
    applyGroupedUpdates(
      supabase,
      rows.map((row) => ({
        account_uid: row.account_uid,
        entry_reference: row.entry_reference,
        update: { flow_type: resolveFlowType(row), flow_source: flowSourceFor(row) },
        guardColumn: 'flow_type',
      })),
    ),
  );

  const refunded = await markRefunds();
  console.log(`Done. Classified ${totalClassified} transaction(s), paired ${refunded} refund(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}

module.exports = { classifyAll, resolveFlowType, flowSourceFor, markRefunds, BATCH_SIZE };
