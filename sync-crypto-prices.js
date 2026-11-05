require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchWithTimeout } = require('./http');
const { errorTag } = require('./log-safe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Every user's coins: anyone can add crypto in the dashboard, so prices can't be limited to
// the owner's USER_ID.
async function fetchHoldings() {
  const { data, error } = await supabase
    .from('crypto_holdings')
    .select('user_id, asset_symbol, name, amount, source, coingecko_id');
  if (error) throw error;
  return data;
}

async function fetchPrices(coingeckoIds) {
  const ids = [...new Set(coingeckoIds)].join(',');
  const res = await fetchWithTimeout(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getLatestUsdToEurRate() {
  const { data, error } = await supabase
    .from('fx_rates')
    .select('rate_to_eur')
    .eq('currency', 'USD')
    .order('date', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) throw new Error('No fx_rates row for USD');
  return data[0].rate_to_eur;
}

// One snapshot per holding, each under its own user. A coin without a price is skipped.
function cryptoRows(holdings, prices, usdToEur, today) {
  const rows = [];
  for (const [i, holding] of holdings.entries()) {
    const priceUsd = prices[holding.coingecko_id]?.usd;
    if (!(priceUsd > 0)) {
      console.error(`No price found for holding ${i + 1}/${holdings.length}`);
      continue;
    }
    const valueUsd = priceUsd * holding.amount;
    rows.push({
      user_id: holding.user_id,
      asset_symbol: holding.asset_symbol,
      source: holding.source,
      snapshot_date: today,
      amount: holding.amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      value_eur: valueUsd * usdToEur,
    });
  }
  return rows;
}

async function main() {
  const holdings = await fetchHoldings();
  if (holdings.length === 0) {
    console.log('No crypto holdings to price.');
    return;
  }

  const prices = await fetchPrices(holdings.map((h) => h.coingecko_id));
  const usdToEur = await getLatestUsdToEurRate();
  const today = new Date().toISOString().slice(0, 10);
  const rows = cryptoRows(holdings, prices, usdToEur, today);

  if (rows.length > 0) {
    const { error } = await supabase
      .from('crypto_snapshots')
      .upsert(rows, { onConflict: 'user_id,asset_symbol,source,snapshot_date' });
    if (error) throw error;
  }

  console.log(`\nSaved ${rows.length} snapshot(s) for ${today}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}

module.exports = { cryptoRows };
