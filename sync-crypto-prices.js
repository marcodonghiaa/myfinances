require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const USER_ID = process.env.USER_ID;

async function fetchHoldings() {
  const { data, error } = await supabase
    .from('crypto_holdings')
    .select('asset_symbol, name, amount, source, coingecko_id')
    .eq('user_id', USER_ID);
  if (error) throw error;
  return data;
}

async function fetchPrices(coingeckoIds) {
  const ids = [...new Set(coingeckoIds)].join(',');
  const res = await fetch(
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

async function main() {
  if (!USER_ID) throw new Error('USER_ID missing from .env');

  const holdings = await fetchHoldings();
  if (holdings.length === 0) {
    console.log('No crypto holdings to price.');
    return;
  }

  const prices = await fetchPrices(holdings.map((h) => h.coingecko_id));
  const usdToEur = await getLatestUsdToEurRate();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const holding of holdings) {
    const priceUsd = prices[holding.coingecko_id]?.usd;
    if (priceUsd == null) {
      console.error(`No price found for ${holding.name} (${holding.coingecko_id})`);
      continue;
    }
    const valueUsd = priceUsd * holding.amount;
    const valueEur = valueUsd * usdToEur;

    rows.push({
      user_id: USER_ID,
      asset_symbol: holding.asset_symbol,
      source: holding.source,
      snapshot_date: today,
      amount: holding.amount,
      price_usd: priceUsd,
      value_usd: valueUsd,
      value_eur: valueEur,
    });

    console.log(`${holding.name} (${holding.source}): ${holding.amount} @ $${priceUsd} = €${valueEur.toFixed(2)}`);
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('crypto_snapshots')
      .upsert(rows, { onConflict: 'user_id,asset_symbol,source,snapshot_date' });
    if (error) throw error;
  }

  const total = rows.reduce((sum, r) => sum + r.value_eur, 0);
  console.log(`\nSaved ${rows.length} snapshot(s) for ${today}. Total crypto value: €${total.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
