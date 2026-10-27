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

function resolveFlowType(row) {
  if (TRANSFER_CODES.has(row.bank_transaction_code)) return 'transfer';
  return row.credit_debit_indicator === 'DBIT' ? 'spend' : 'income';
}

async function fetchUnclassified() {
  const { data, error } = await supabase
    .from('transactions')
    .select('entry_reference, account_uid, bank_transaction_code, credit_debit_indicator')
    .is('flow_type', null)
    .limit(BATCH_SIZE);
  if (error) throw error;
  return data;
}

const PAGE_SIZE = 1000; // PostgREST caps a response at 1000 rows

// Rows still counted as spend/income, recent enough to hold either side of a refund pair.
async function fetchRefundCandidates() {
  const since = new Date(Date.now() - 2 * WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('entry_reference, account_uid, amount, currency, credit_debit_indicator, creditor_name, remittance_info, booking_date')
      .in('flow_type', ['spend', 'income'])
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
async function markRefunds() {
  const pairs = matchRefunds(await fetchRefundCandidates());
  const guardIn = ['spend', 'income'];
  await applyGroupedUpdates(
    supabase,
    pairs.flatMap(({ debit, credit }) => [
      { ...debit, update: { flow_type: 'refunded' }, guardColumn: 'flow_type', guardIn },
      { ...credit, update: { flow_type: 'refunded', refund_of: debit.entry_reference }, guardColumn: 'flow_type', guardIn },
    ]),
  );
  return pairs.length;
}

async function main() {
  let totalClassified = 0;
  while (true) {
    const rows = await fetchUnclassified();
    if (rows.length === 0) break;

    await applyGroupedUpdates(
      supabase,
      rows.map((row) => ({
        account_uid: row.account_uid,
        entry_reference: row.entry_reference,
        update: { flow_type: resolveFlowType(row) },
        guardColumn: 'flow_type',
      })),
    );

    totalClassified += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  const refunded = await markRefunds();
  console.log(`Done. Classified ${totalClassified} transaction(s), paired ${refunded} refund(s).`);
}

main().catch((err) => {
  console.error(`Failed: ${errorTag(err)}`);
  process.exit(1);
});
