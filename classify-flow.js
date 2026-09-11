// Classifies each transaction's flow_type: 'spend', 'income', or 'transfer'.
// Deterministic only, no AI call -- the bank's own transaction code already
// says everything needed. Confirmed against real data: EXCHANGE (currency
// conversion) and TOPUP (self-funding a wallet from your own other account)
// are the only two codes that reliably mean "not real income", and every
// other code (including TRANSFER, used for regular P2P payments to friends)
// stays as ordinary spend/income.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

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
    .select('entry_reference, bank_transaction_code, credit_debit_indicator')
    .is('flow_type', null)
    .limit(BATCH_SIZE);
  if (error) throw error;
  return data;
}

async function main() {
  let totalClassified = 0;
  while (true) {
    const rows = await fetchUnclassified();
    if (rows.length === 0) break;

    for (const row of rows) {
      const { error } = await supabase
        .from('transactions')
        .update({ flow_type: resolveFlowType(row) })
        .eq('entry_reference', row.entry_reference)
        .is('flow_type', null);
      if (error) console.error(`Failed to update ${row.entry_reference}:`, error.message);
    }

    totalClassified += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`Done. Classified ${totalClassified} transaction(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
