const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// protects=following the documented test command never runs the real installer; fails_when=the
// doc says `node --test installer/`, which on Node 22 also runs installer/index.js (it downloads,
// installs and calls Supabase) (polish 5, item 1)
test('the installer test command runs only the test files', () => {
  const line = read('installer/README.md').split('\n').find((l) => l.startsWith('Tests:'));
  assert.ok(line, 'installer/README.md has a Tests: line');
  assert.doesNotMatch(line, /node --test installer\/`/);
  assert.match(line, /npm test|installer\/\*\.test\.js/);
});
