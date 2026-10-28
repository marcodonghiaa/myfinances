const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

// The GitHub workflow reads its configuration from repository secrets; setup.sh writes them.
// A secret added to one and not the other would leave the sync quietly misconfigured.
test('setup.sh writes every secret the sync workflow reads', () => {
  const workflow = fs.readFileSync('.github/workflows/sync.yml', 'utf8');
  const read = new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]));
  const setup = fs.readFileSync('setup.sh', 'utf8');
  const written = new Set([...setup.matchAll(/^\s*gh_secret ([A-Z_]+) /gm)].map((m) => m[1]));
  assert.deepStrictEqual([...read].sort(), [...written].sort());
});

test('setup.sh turns the workflow on with the variable it checks', () => {
  const workflow = fs.readFileSync('.github/workflows/sync.yml', 'utf8');
  const setup = fs.readFileSync('setup.sh', 'utf8');
  assert.match(workflow, /vars\.SYNC_ON_GITHUB == 'true'/);
  assert.match(setup, /gh variable set SYNC_ON_GITHUB --body true/);
});

test('setup.sh finishes in one run and every failure says what to do next', () => {
  const setup = fs.readFileSync('setup.sh', 'utf8');
  assert.ok(setup.includes('db push --linked --yes'));
  assert.ok(setup.includes('Fix that, then run ./setup.sh again: answers already saved in .env are reused.'));
  assert.ok(setup.includes('artifact-and-log-retention'));
  assert.ok(setup.includes('--dashboard-url'));
  assert.ok(setup.includes('Done! Open $DASHBOARD_URL and sign in as $SIGN_IN_AS'));
  assert.doesNotMatch(setup, /^\s*(VITE_)?SUPABASE_PROJECT_ID=/m);
  assert.match(fs.readFileSync('.gitignore', 'utf8'), /^dashboard-values\.txt$/m);
});

// The dashboard registers its own address (dashboard_origins), so setup must not ask for one,
// and must not ask the user to run setup a second time.
test('setup.sh no longer asks for the dashboard address or a second run', () => {
  const setup = fs.readFileSync('setup.sh', 'utf8');
  assert.doesNotMatch(setup, /read -rp "Dashboard address/);
  assert.doesNotMatch(setup, /Then run \.\/setup\.sh --dashboard-url/);
  assert.match(setup, /dashboard_origins\?select=origin/);
  assert.match(setup, /\[ -t 0 \]/);
});
