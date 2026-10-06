require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const CURRENCIES = ['USD', 'GBP', 'CHF']; // add more here as you add accounts in other currencies
const HISTORY_DAYS = 100; // transaction sync pulls 90 days; every view needs a rate on or before each booking_date
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function fetchRates(path) {
  const res = await fetch(`https://api.frankfurter.dev/v1/${path}?base=EUR&symbols=${CURRENCIES.join(',')}`);
  if (!res.ok) throw new Error(`Frankfurter API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function toRows(date, rates) {
  const rows = [{ date, currency: 'EUR', rate_to_eur: 1 }];
  for (const [currency, unitsPerEur] of Object.entries(rates)) {
    rows.push({ date, currency, rate_to_eur: 1 / unitsPerEur });
  }
  return rows;
}

async function upsertRows(rows) {
  const { error } = await supabase.from('fx_rates').upsert(rows, { onConflict: 'date,currency' });
  if (error) throw error;
}

// A fresh install only ever gets "latest", so transactions booked before the
// first fx_rates row would silently drop out of the inner-joined views.
async function backfillIfEmpty() {
  const { data, error } = await supabase.from('fx_rates').select('date').lt('date', daysAgo(HISTORY_DAYS - 20)).limit(1);
  if (error) throw error;
  if (data.length > 0) return;

  const series = await fetchRates(`${daysAgo(HISTORY_DAYS)}..`);
  const rows = Object.entries(series.rates).flatMap(([date, rates]) => toRows(date, rates));
  await upsertRows(rows);
  console.log(`Backfilled ${rows.length} FX rows from ${series.start_date}.`);
}

async function main() {
  await backfillIfEmpty();

  const data = await fetchRates('latest');
  const rows = toRows(data.date, data.rates);
  await upsertRows(rows);

  console.log(`Synced FX rates for ${data.date}:`, rows.map((r) => `${r.currency}=${r.rate_to_eur.toFixed(4)}`).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
