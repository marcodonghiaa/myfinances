require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchWithTimeout } = require('./http');
const { parseQuote, nextAssetType } = require('./yahoo-quote');
const { errorTag } = require('./log-safe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Every user's holdings: anyone can add investments in the dashboard, so prices can't be
// limited to the owner's USER_ID.
async function fetchHoldings() {
  const { data, error } = await supabase
    .from('portfolio_holdings')
    .select('user_id, isin, yahoo_symbol, name, shares, asset_type');
  if (error) throw error;
  return data;
}

async function fetchQuote(symbol) {
  const res = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error(`Yahoo Finance error ${res.status} for ${symbol}: ${await res.text()}`);
  return parseQuote(await res.json(), symbol);
}

async function getLatestFxRate(currency) {
  if (currency === 'EUR') return 1;
  const { data, error } = await supabase
    .from('fx_rates')
    .select('rate_to_eur')
    .eq('currency', currency)
    .order('date', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) throw new Error(`No fx_rates row for currency ${currency}`);
  return data[0].rate_to_eur;
}

// One snapshot per holding, each under its own user. A symbol held by several users is
// fetched once. A holding that can't be priced is skipped and logged.
async function priceHoldings(holdings, getQuote, getRate, today) {
  const quotes = new Map();
  const quoteOf = (symbol) => {
    if (!quotes.has(symbol)) quotes.set(symbol, getQuote(symbol));
    return quotes.get(symbol);
  };
  const rows = [];
  const typeUpdates = [];
  for (const [i, holding] of holdings.entries()) {
    try {
      const { price, currency, assetType } = await quoteOf(holding.yahoo_symbol);
      const valueNative = price * holding.shares;
      rows.push({
        user_id: holding.user_id,
        isin: holding.isin,
        snapshot_date: today,
        price,
        currency,
        value_native: valueNative,
        value_eur: valueNative * (await getRate(currency)),
      });
      const newType = assetType && nextAssetType(holding.asset_type, assetType);
      if (newType && newType !== holding.asset_type) {
        typeUpdates.push({ user_id: holding.user_id, isin: holding.isin, asset_type: newType });
      }
    } catch (err) {
      console.error(`Failed to price holding ${i + 1}/${holdings.length}: ${errorTag(err)}`);
    }
  }
  return { rows, typeUpdates };
}

async function main() {
  const holdings = await fetchHoldings();
  const today = new Date().toISOString().slice(0, 10);
  const { rows, typeUpdates } = await priceHoldings(holdings, fetchQuote, getLatestFxRate, today);

  for (const update of typeUpdates) {
    const { error } = await supabase
      .from('portfolio_holdings')
      .update({ asset_type: update.asset_type })
      .eq('user_id', update.user_id)
      .eq('isin', update.isin);
    if (error) console.error(`Failed to update asset_type for a holding: ${errorTag(error)}`);
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('portfolio_snapshots')
      .upsert(rows, { onConflict: 'user_id,isin,snapshot_date' });
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

module.exports = { priceHoldings };
