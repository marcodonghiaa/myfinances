// Deno port of sync-crypto-coinbase.js + coinbase-holdings.js: the owner's Coinbase balances
// become crypto_holdings rows (source 'Coinbase'), priced afterwards by the crypto step.
// Optional: without the key name and private key there is nothing to sync.
// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const HOST = "api.coinbase.com";
const PATH = "/api/v3/brokerage/accounts";
// A cursor that never ends must not loop forever. ponytail: no time budget, one owner's accounts
// fit one 250-row page; pass a deadline into fetchAllAccounts if that ever stops being true.
const MAX_PAGES = 50;

// Known Coinbase currency codes -> CoinGecko IDs (a symbol like "SOL" is ambiguous on CoinGecko,
// so this is a deliberate allowlist rather than an automatic symbol search).
export const COINGECKO_ID_MAP: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  SD: "stader",
  ETHX: "stader-ethx",
};

// Holding rows to upsert, plus the symbols that now report exactly zero (sold down) so a stale
// amount isn't priced. A missing or unparseable balance is skipped, never read as zero.
export function planHoldings(accounts: Json[], userId: string) {
  const rows = [];
  const zeroed: string[] = [];
  const unmapped: string[] = [];
  for (const account of accounts) {
    const symbol = account.currency;
    const raw = account.available_balance?.value;
    const amount = raw == null ? NaN : parseFloat(raw);
    if (Number.isNaN(amount)) continue;
    const coingeckoId = COINGECKO_ID_MAP[symbol];
    if (amount === 0) {
      if (coingeckoId) zeroed.push(symbol);
      continue;
    }
    if (!coingeckoId) {
      unmapped.push(symbol);
      continue;
    }
    rows.push({ user_id: userId, asset_symbol: symbol, name: account.name || symbol, amount, source: "Coinbase", coingecko_id: coingeckoId });
  }
  return { rows, zeroed, unmapped };
}

export async function fetchAllAccounts(getPage: (cursor: string | null) => Promise<Json>) {
  const accounts = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getPage(cursor);
    accounts.push(...(data.accounts || []));
    if (!data.has_next || !data.cursor || data.cursor === cursor) return accounts;
    cursor = data.cursor;
  }
  throw Object.assign(new Error("too many Coinbase pages"), { code: "COINBASE_PAGES" });
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

// Coinbase issues Ed25519 keys as base64 of 64 bytes (32-byte seed + 32-byte public key).
// WebCrypto wants PKCS8: the seed behind the fixed Ed25519 PKCS8 DER prefix.
export function importCoinbaseKey(base64Key: string): Promise<CryptoKey> {
  const seed = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0)).subarray(0, 32);
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  return crypto.subtle.importKey("pkcs8", new Uint8Array([...prefix, ...seed]), { name: "Ed25519" }, false, ["sign"]);
}

export async function buildJwt(keyName: string, key: CryptoKey, now = Math.floor(Date.now() / 1000)) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "EdDSA", typ: "JWT", kid: keyName, nonce };
  const payload = { sub: keyName, iss: "cdp", nbf: now, exp: now + 120, uri: `GET ${HOST}${PATH}` };
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(signature)}`;
}

export interface CoinbaseConfig {
  keyName?: string;
  privateKey?: string;
  userId?: string; // whose holdings these are: the Coinbase key belongs to one user
}

/** Returns the rows synced, or null when Coinbase isn't configured. */
export async function syncCoinbase(db: Db, config: CoinbaseConfig, fetchFn: typeof fetch = fetch): Promise<number | null> {
  if (!config.keyName || !config.privateKey) return null;
  if (!config.userId) throw Object.assign(new Error("COINBASE_USER_ID missing"), { code: "COINBASE_USER_ID_MISSING" });
  const key = await importCoinbaseKey(config.privateKey);
  // The signed uri is the path alone, without the query.
  const accounts = await fetchAllAccounts(async (cursor) => {
    const params = new URLSearchParams({ limit: "250" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetchFn(`https://${HOST}${PATH}?${params}`, {
      headers: { Authorization: `Bearer ${await buildJwt(config.keyName!, key)}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Object.assign(new Error(`Coinbase API error ${res.status}`), { status: res.status });
    return res.json();
  });
  const { rows, zeroed, unmapped } = planHoldings(accounts, config.userId);
  if (unmapped.length > 0) console.warn(`Skipping ${unmapped.length} Coinbase asset(s): no CoinGecko ID mapped.`);
  if (rows.length > 0) {
    const { error } = await db.from("crypto_holdings").upsert(rows, { onConflict: "user_id,asset_symbol,source" });
    if (error) throw error;
  }
  // Sold down to zero: update existing holdings only, never insert empty ones.
  if (zeroed.length > 0) {
    const { error } = await db
      .from("crypto_holdings").update({ amount: 0 })
      .eq("user_id", config.userId).eq("source", "Coinbase").in("asset_symbol", zeroed).gt("amount", 0);
    if (error) throw error;
  }
  return rows.length;
}
