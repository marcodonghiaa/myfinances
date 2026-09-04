require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const USER_ID = process.env.USER_ID;

async function fetchHoldings() {
  const { data, error } = await supabase
    .from('portfolio_holdings')
    .select('isin, yahoo_symbol, name, shares')
    .eq('user_id', USER_ID);
  if (error) throw error;
  return data;
}

async function fetchQuote(symbol) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error(`Yahoo Finance error ${res.status} for ${symbol}: ${await res.text()}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`No quote data for ${symbol}: ${JSON.stringify(data.chart?.error)}`);
  return { price: result.meta.regularMarketPrice, currency: result.meta.currency };
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

async function main() {
  if (!USER_ID) throw new Error('USER_ID missing from .env');

  const holdings = await fetchHoldings();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const holding of holdings) {
    try {
      const { price, currency } = await fetchQuote(holding.yahoo_symbol);
      const rateToEur = await getLatestFxRate(currency);
      const valueNative = price * holding.shares;
      const valueEur = valueNative * rateToEur;

      rows.push({
        user_id: USER_ID,
        isin: holding.isin,
        snapshot_date: today,
        price,
        currency,
        value_native: valueNative,
        value_eur: valueEur,
      });

      console.log(`${holding.name}: ${price} ${currency} x ${holding.shares} = ${valueEur.toFixed(2)} EUR`);
    } catch (err) {
      console.error(`Failed to price ${holding.name} (${holding.yahoo_symbol}):`, err.message);
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('portfolio_snapshots')
      .upsert(rows, { onConflict: 'user_id,isin,snapshot_date' });
    if (error) throw error;
  }

  const total = rows.reduce((sum, r) => sum + r.value_eur, 0);
  console.log(`\nSaved ${rows.length} snapshot(s) for ${today}. Total portfolio value: ${total.toFixed(2)} EUR`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
