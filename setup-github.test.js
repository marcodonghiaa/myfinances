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
