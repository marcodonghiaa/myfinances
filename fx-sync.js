require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const CURRENCIES = ['USD', 'GBP', 'CHF']; // add more here as you add accounts in other currencies

async function main() {
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${CURRENCIES.join(',')}`);
  if (!res.ok) throw new Error(`Frankfurter API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const rows = [{ date: data.date, currency: 'EUR', rate_to_eur: 1 }];
  for (const [currency, unitsPerEur] of Object.entries(data.rates)) {
    rows.push({ date: data.date, currency, rate_to_eur: 1 / unitsPerEur });
  }

  const { error } = await supabase.from('fx_rates').upsert(rows, { onConflict: 'date,currency' });
  if (error) throw error;

  console.log(`Synced FX rates for ${data.date}:`, rows.map((r) => `${r.currency}=${r.rate_to_eur.toFixed(4)}`).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
