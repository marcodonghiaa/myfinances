// Preloaded (node -r) by leak-guard.test.js in front of a real sync script: swaps
// @supabase/supabase-js and fetch for fakes seeded with FIXTURE values. No network.
// LEAK_SCENARIO picks what the bank, Yahoo, CoinGecko and the database answer.
// Not a test file itself: `npm test` only runs *.test.js.
const Module = require('node:module');

// Unmistakable personal data: if any of it reaches stdout or stderr, the guard fails.
const FIXTURE = {
  holder: 'Zzyzx Quibblethorpe',
  iban: 'ZZ99LEAKGUARD00112233',
  merchant: 'Qwertyuiop Emporium',
  remittance: 'Invoice Plugh-5150',
  amount: '7777.77',
  balance: '4242.42',
  holding: 'Flurbo Xenon Fund',
  shares: '13579.24',
  price: '8642.5',
  isin: 'ZZ000LEAKISIN',
  symbol: 'LEAKSYM.ZZ',
  coin: 'Leakcoin Prime',
};
const LEAK = Object.values(FIXTURE).join(' | ');

const scenario = process.env.LEAK_SCENARIO;
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

const ACCOUNT = {
  uid: 'acc-1', eb_account_uid: 'eb-1', currency: 'EUR', label: FIXTURE.holder, iban: FIXTURE.iban,
  identification_hash: null, created_at: daysFromNow(-1),
  // Inside the 14-day warning window, so session-check prints its warning too.
  consent_valid_until: daysFromNow(scenario === 'expired' ? 30 : 5),
};

// EB failures carry the fixtures in message/body: a script that echoed either would leak.
const ebRejection = (status, body) => ({ ok: false, status, body, text: JSON.stringify(body) });
const EB_ANSWERS = {
  ok: {
    details: { identification_hash: 'h', name: FIXTURE.holder, account_id: { iban: FIXTURE.iban } },
    balances: { balances: [{ balance_amount: { amount: FIXTURE.balance, currency: 'EUR' } }] },
    transactions: {
      transactions: [{
        entry_reference: 'ref-1', booking_date: '2026-10-26', value_date: '2026-10-26',
        transaction_amount: { amount: `-${FIXTURE.amount}`, currency: 'EUR' }, credit_debit_indicator: 'DBIT',
        creditor: { name: FIXTURE.merchant }, debtor: { name: FIXTURE.holder },
        remittance_information: [FIXTURE.remittance],
      }],
    },
  },
  bank_error: ebRejection(500, { error: `Bank said ${LEAK}`, message: LEAK }),
  expired: ebRejection(401, { code: 401, error: 'EXPIRED_SESSION', message: LEAK, detail: LEAK }),
};
const EB_ANSWER = EB_ANSWERS[scenario] || EB_ANSWERS.ok;

function respondFetch(url) {
  const reject = (r) => ({ ...r, json: async () => r.body });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.startsWith('https://api.enablebanking.com/accounts/')) {
    if (EB_ANSWER.ok === false) return reject(EB_ANSWER);
    return ok(EB_ANSWERS.ok[url.split('?')[0].split('/').pop()]);
  }
  if (scenario === 'bank_error' && /yahoo|coingecko/.test(url)) {
    return { ok: false, status: 500, json: async () => ({}), text: async () => LEAK };
  }
  if (url.includes('finance.yahoo.com')) {
    return ok({ chart: { result: [{ meta: { regularMarketPrice: Number(FIXTURE.price), currency: 'EUR', instrumentType: 'ETF', symbol: FIXTURE.symbol } }] } });
  }
  if (url.includes('coingecko.com')) return ok({ 'leakcoin-prime': { usd: Number(FIXTURE.price) } });
  throw new Error(`leak-guard fixture: unexpected network call ${url}`);
}

// Supabase fake. Any chained call returns the builder; awaiting it answers by table.
const dbError = { message: LEAK, details: LEAK, hint: LEAK };
function answer(table, calls) {
  const first = calls[0];
  const select = first.name === 'select' ? String(first.args[0]) : null;
  // Every query fails except the user list, so the per-user and per-account error paths run too.
  if (scenario === 'db_error' && !(table === 'accounts' && select === 'user_id')) return { data: null, error: dbError };
  if (table === 'accounts' && select === 'user_id') return { data: [{ user_id: 'user-1' }], error: null };
  if (table === 'accounts' && select) {
    const rows = scenario === 'zero_accounts' ? [] : [ACCOUNT];
    return { data: rows, error: null };
  }
  if (table === 'portfolio_holdings') {
    return { data: [{ isin: FIXTURE.isin, yahoo_symbol: FIXTURE.symbol, name: FIXTURE.holding, shares: Number(FIXTURE.shares), asset_type: null }], error: null };
  }
  if (table === 'crypto_holdings') {
    return { data: [{ asset_symbol: 'LKC', name: FIXTURE.coin, amount: Number(FIXTURE.shares), source: 'Manual', coingecko_id: 'leakcoin-prime' }], error: null };
  }
  if (table === 'fx_rates') return { data: scenario === 'no_fx' ? [] : [{ rate_to_eur: 0.9 }], error: null };
  if (table === 'sync_cursors' && select) return { data: [], error: null };
  return { data: null, error: null };
}

function fakeClient() {
  return {
    from: (table) => {
      const calls = [];
      const builder = new Proxy({}, {
        get: (_, name) => name === 'then'
          ? (resolve) => resolve(answer(table, calls))
          : (...args) => (calls.push({ name, args }), builder),
      });
      // from() itself is not a call: the first chained method (select/update/upsert) is calls[0].
      return builder;
    },
  };
}

// Only patched when a scenario is set, so the test can require() this file just for FIXTURE.
if (scenario) {
  global.fetch = async (url) => respondFetch(String(url));
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === '@supabase/supabase-js' ? { createClient: fakeClient } : realLoad.call(this, request, ...rest);
  };
}

module.exports = { FIXTURE };
