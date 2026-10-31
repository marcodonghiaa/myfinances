require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { backfillPriceHistory } = require('./price-history');
const { errorTag } = require('./log-safe');

// Up to a year of past prices for the holdings you have, so Portfolio and Crypto can show price
// returns for ranges that start before your first snapshot. Runs on its own after setup
// (`node backfill-price-history.js`, `--force` refetches everything) and as the last step of the
// daily sync, which only tops up holdings whose newest stored price is older than 3 days. Safe to re-run.
// Needs the 20261107000000 migration; without it this says so and does nothing.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const USER_ID = process.env.USER_ID;

async function main() {
  if (!USER_ID) throw new Error('USER_ID missing from .env');
  const result = await backfillPriceHistory({ supabase, userId: USER_ID, force: process.argv.includes('--force') });
  if (result.tableMissing) {
    console.log('price_history not found: apply the latest migration (supabase db push), then run this again.');
    return;
  }
  console.log(`Price history: ${result.filled} filled, ${result.failed} failed, ${result.complete} already complete.`);
  // Exit 0 even when some failed: a flaky price source must not mark the whole daily sync as failed.
}

main().catch((err) => {
  console.error(`Failed: ${errorTag(err)}`);
  process.exit(1);
});
