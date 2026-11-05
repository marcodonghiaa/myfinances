require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { fetchWithTimeout } = require('./http');
const { planHoldings } = require('./coinbase-holdings');
const { errorTag } = require('./log-safe');

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

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Builds and signs the JWT by hand -- Node's crypto module natively supports
// Ed25519 signing (sign algorithm = null).
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

// Coinbase returns about 49 accounts per page by default; follow the cursor so coins past the
// first page are updated too. The signed uri is the path alone, without the query.
async function fetchPage(cursor) {
  const params = new URLSearchParams({ limit: '250' });
  if (cursor) params.set('cursor', cursor);
  const res = await fetchWithTimeout(`https://${HOST}${PATH}?${params}`, {
    headers: { Authorization: `Bearer ${buildJwt()}` },
  });
  if (!res.ok) throw new Error(`Coinbase API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const MAX_PAGES = 50; // a cursor that never ends must not loop forever

async function fetchAllAccounts(getPage) {
  const accounts = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getPage(cursor);
    accounts.push(...(data.accounts || []));
    if (!data.has_next || !data.cursor || data.cursor === cursor) return accounts;
    cursor = data.cursor;
  }
  throw new Error(`Coinbase returned more than ${MAX_PAGES} pages of accounts`);
}

const fetchCoinbaseAccounts = () => fetchAllAccounts(fetchPage);

async function main() {
  if (!USER_ID) throw new Error('USER_ID missing from .env');
  // Coinbase is optional: without both keys there is nothing to sync, not an error.
  if (!KEY_NAME || !process.env.COINBASE_API_PRIVATE_KEY) {
    console.log('Coinbase is not configured, skipping.');
    return;
  }

  const accounts = await fetchCoinbaseAccounts();
  const { rows, zeroed, unmapped } = planHoldings(accounts, USER_ID);
  if (unmapped.length > 0) {
    console.warn(`Skipping ${unmapped.length} asset(s): no CoinGecko ID mapped. Add them to COINGECKO_ID_MAP if they should be tracked.`);
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('crypto_holdings')
      .upsert(rows, { onConflict: 'user_id,asset_symbol,source' });
    if (error) throw error;
  }

  // Sold down to zero: update existing holdings only, never insert empty ones.
  if (zeroed.length > 0) {
    const { error } = await supabase
      .from('crypto_holdings')
      .update({ amount: 0 })
      .eq('user_id', USER_ID)
      .eq('source', 'Coinbase')
      .in('asset_symbol', zeroed)
      .gt('amount', 0);
    if (error) throw error;
  }

  console.log(`Synced ${rows.length} Coinbase holding(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${errorTag(err)}`);
    process.exit(1);
  });
}

module.exports = { fetchAllAccounts };
