const { checkSessionExpiry } = require('./check-session');
checkSessionExpiry();

require('dotenv').config();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const APP_ID = process.env.APP_ID;
const PRIVATE_KEY = fs.readFileSync(process.env.PRIVATE_KEY_FILE, 'utf8');
const FETCH_TIMEOUT_MS = 60000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);


const ACCOUNTS = [
  { uid: '504db292-966a-4808-ad70-8d660cd87686', currency: 'EUR' },
  { uid: '04f7711e-a065-41f5-a97b-4db6d5db86d1', currency: 'USD' },
  { uid: 'a97a916a-909b-4550-9aa3-b7d1e77ebbb6', currency: 'GBP' },
];

function getToken() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    PRIVATE_KEY,
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256', kid: APP_ID } }
  );
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getBalances(token, uid) {
  const res = await fetchWithTimeout(`https://api.enablebanking.com/accounts/${uid}/balances`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const token = getToken();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const account of ACCOUNTS) {
    console.log(`\n=== ${account.currency} account ===`);
    const data = await getBalances(token, account.uid);
    const balance = data.balances?.[0];

    if (!balance) {
      console.log('No balance returned.');
      continue;
    }

    const amount = parseFloat(balance.balance_amount.amount);
    console.log(`Balance: ${amount} ${balance.balance_amount.currency}`);

    rows.push({
      account_uid: account.uid,
      currency: balance.balance_amount.currency,
      amount,
      snapshot_date: today,
    });
  }

  if (rows.length > 0) {
    // one snapshot per account per day — upsert avoids duplicate rows if run twice same day
    const { error } = await supabase
      .from('net_worth_snapshots')
      .upsert(rows, { onConflict: 'account_uid,snapshot_date' });

    if (error) {
      console.error('Supabase insert error:', error.message);
    } else {
      console.log(`\nSaved ${rows.length} snapshot(s) for ${today}.`);
    }
  }
}

main();