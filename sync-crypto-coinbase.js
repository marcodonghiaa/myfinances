require('dotenv').config();
const crypto = require('crypto');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const USER_ID = process.env.USER_ID;
const KEY_NAME = process.env.COINBASE_API_KEY_NAME;

// Coinbase issues Ed25519 keys as a raw base64 string decoding to 64 bytes
// (32-byte seed + 32-byte public key). Node's crypto needs a PKCS8-wrapped
// key, so we take the seed and prepend the fixed Ed25519 PKCS8 DER prefix.
function loadEd25519PrivateKey(base64Key) {
  const raw = Buffer.from(base64Key, 'base64');
  const seed = raw.subarray(0, 32);
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

let cachedPrivateKey;
function getPrivateKey() {
  if (!cachedPrivateKey) {
    cachedPrivateKey = loadEd25519PrivateKey(process.env.COINBASE_API_PRIVATE_KEY || '');
  }
  return cachedPrivateKey;
}

const HOST = 'api.coinbase.com';
const PATH = '/api/v3/brokerage/accounts';

// Known Coinbase currency codes -> CoinGecko IDs. Extend this if new assets show up
// (a symbol like "SOL" is ambiguous on CoinGecko, so this is a deliberate allowlist
// rather than an automatic symbol search).
const COINGECKO_ID_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  SD: 'stader',
  ETHX: 'stader-ethx',
};

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// jsonwebtoken (used elsewhere in this repo for Enable Banking's RS256 JWTs)
// doesn't support EdDSA, so this builds and signs the JWT by hand -- Node's
// crypto module natively supports Ed25519 signing (sign algorithm = null).
function buildJwt() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'EdDSA', typ: 'JWT', kid: KEY_NAME, nonce };
  const payload = {
    sub: KEY_NAME,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri: `GET ${HOST}${PATH}`,
  };

  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), getPrivateKey());
  return `${signingInput}.${base64url(signature)}`;
}

async function fetchCoinbaseAccounts() {
  const token = buildJwt();
  const res = await fetch(`https://${HOST}${PATH}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Coinbase API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.accounts || [];
}

async function main() {
  if (!USER_ID) throw new Error('USER_ID missing from .env');
  if (!KEY_NAME || !process.env.COINBASE_API_PRIVATE_KEY) {
    throw new Error('COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY missing from .env');
  }

  const accounts = await fetchCoinbaseAccounts();
  const rows = [];

  for (const account of accounts) {
    const symbol = account.currency;
    const amount = parseFloat(account.available_balance?.value ?? '0');
    if (!amount || amount === 0) continue; // skip empty/dust accounts

    const coingeckoId = COINGECKO_ID_MAP[symbol];
    if (!coingeckoId) {
      console.warn(`Skipping ${symbol}: no CoinGecko ID mapped. Add it to COINGECKO_ID_MAP if this should be tracked.`);
      continue;
    }

    rows.push({
      user_id: USER_ID,
      asset_symbol: symbol,
      name: account.name || symbol,
      amount,
      source: 'Coinbase',
      coingecko_id: coingeckoId,
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('crypto_holdings')
      .upsert(rows, { onConflict: 'user_id,asset_symbol,source' });
    if (error) throw error;
  }

  console.log(`Synced ${rows.length} Coinbase holding(s):`);
  for (const row of rows) console.log(`  ${row.name}: ${row.amount} ${row.asset_symbol}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
