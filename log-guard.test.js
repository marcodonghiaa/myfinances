const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

// Forks of a public repo are public, and so are their GitHub Actions logs: a script may print
// counts, positions, status codes, error codes/names and fixed text, never personal data.
// A line-based backstop, not a proof: a renamed variable slips past it.

// Only run by setup.sh, or by hand for the CSV imports, in the user's own terminal: never in a scheduled (public) run.
const EXCLUDED = ['env-file.js', 'first-user.js', 'net-worth-history.js', 'spend-history.js'];

const CONSOLE_CALL = /console\.(log|error|warn|info)\(.*/;
// Stripped before the checks: the allowed forms that would otherwise look like a leak.
const ALLOWED = /\b(err|error)\.name\b|\btotal(Categorized|Classified)\b|JSON\.stringify\(result\)/g;
const LEAKS = [
  /\$\{[^}]*(\bname\b|label|creditor_name|debtor_name|amount|shares|balance|price|value|total|iban|message|\bdescription\b|\bremittance\b|\bentry_reference\b|\buser_id\b)[^}]*\}/,
  /JSON\.stringify/,
  /\.(details|hint|message)\b|\.text\(\)/,
  /, (err|error|row|rows|data|tx|account|holding)\)/,
  /^console\.\w+\((err|error)\)/,
];

// The Deno port of the sync, run by pg_cron: counts only, same rules. The other Edge Functions
// log to the project's private Supabase logs, not to public Actions logs, so they are not held to this.
const EDGE_SYNC_PATHS = ['supabase/functions/_shared/bank-sync.ts', 'supabase/functions/sync-bank/index.ts'];

function leakyLines(file) {
  const offenders = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const call = line.match(CONSOLE_CALL)?.[0].replace(ALLOWED, '');
    if (call && LEAKS.some((re) => re.test(call))) offenders.push(`${file}:${i + 1}`);
  });
  return offenders;
}

test('no script logs personal data, raw responses or error messages', () => {
  const scripts = fs.readdirSync('.').filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !EXCLUDED.includes(f));
  assert.deepStrictEqual(scripts.flatMap(leakyLines), []);
});

test('the Edge Function sync paths log no personal data, raw responses or error messages', () => {
  assert.deepStrictEqual(EDGE_SYNC_PATHS.flatMap(leakyLines), []);
});
