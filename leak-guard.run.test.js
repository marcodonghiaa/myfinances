const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FIXTURE } = require('./leak-guard-fixture');

// Runs the real sync scripts against fake Supabase / Enable Banking / Yahoo / CoinGecko answers
// seeded with FIXTURE (see leak-guard-fixture.js) and fails if any fixture value reaches stdout
// or stderr. Forks are public and so are their Actions logs. The line-based check in
// log-guard.test.js catches a console call that interpolates a field; this one catches the
// leak that check cannot see, e.g. a renamed variable or an error object passed through.
// Not covered: sync-crypto-coinbase.js (needs a Coinbase key) and anything the fixture does not feed it.

const ROOT = __dirname;
const FIXTURE_FILE = path.join(ROOT, 'leak-guard-fixture.js');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-guard-'));

function run(script, scenario) {
  const res = spawnSync(process.execPath, ['-r', FIXTURE_FILE, path.join(ROOT, script)], {
    cwd, // no .env to pick up, and last-sync.json lands here
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: process.env.PATH, LEAK_SCENARIO: scenario, SUPABASE_URL: 'http://localhost:1', SUPABASE_SECRET_KEY: 'x',
      APP_ID: 'app', PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), USER_ID: 'user-1',
    },
  });
  assert.ifError(res.error);
  return `${res.stdout}\n${res.stderr}`;
}

const BANK = ['sync-networth.js', 'sync-transactions.js'];
const PRICES = ['sync-portfolio-prices.js', 'sync-crypto-prices.js'];
const CASES = [
  ...BANK.flatMap((s) => ['ok', 'bank_error', 'expired', 'zero_accounts', 'db_error'].map((sc) => [s, sc])),
  ...PRICES.flatMap((s) => ['ok', 'bank_error', 'no_fx', 'db_error'].map((sc) => [s, sc])),
];

for (const [script, scenario] of CASES) {
  test(`${script} (${scenario}) prints no fixture data`, () => {
    const out = run(script, scenario);
    assert.ok(out.trim(), 'script printed nothing: the fixture is not reaching it');
    assert.ok(!out.includes('node:internal'), `script crashed before syncing:\n${out}`);
    for (const [key, value] of Object.entries(FIXTURE)) {
      assert.ok(!out.toLowerCase().includes(value.toLowerCase()), `${key} leaked:\n${out}`);
    }
  });
}

// The guard is only worth something if the happy path really gets as far as saving.
test('fixture reaches the scripts: the ok path saves its rows', () => {
  assert.match(run('sync-networth.js', 'ok'), /Saved 1 snapshot/);
  assert.match(run('sync-transactions.js', 'ok'), /Upserted 1 transactions/);
  assert.match(run('sync-portfolio-prices.js', 'ok'), /Saved 1 snapshot/);
  assert.match(run('sync-crypto-prices.js', 'ok'), /Saved 1 snapshot/);
});
