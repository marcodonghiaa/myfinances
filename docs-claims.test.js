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

// protects=the README describes post-sync in the order it runs; fails_when=it says Subscription /
// One-time is marked last while post-sync/index.ts runs it right after categories (polish 5, item 6)
test('the README lists the post-sync steps in the order they run', () => {
  const step = read('README.md').split('\n').find((l) => l.startsWith('2. `post-sync`'));
  const code = read('supabase/functions/post-sync/index.ts');
  const order = (text, marks) => marks.map((m) => text.indexOf(m));
  const ran = order(code, ['await categorize(', 'await classifyTypes(', 'await classifyFlows(', 'await markRefunds(']);
  assert.deepStrictEqual([...ran].sort((a, b) => a - b), ran, 'post-sync call order changed; update this test');
  const said = order(step, ['Gemini, for categories', '`Subscription` or `One-time`', 'marks `spend`', 'card refund']);
  assert.ok(said.every((i) => i >= 0), 'README step 2 names every post-sync step');
  assert.deepStrictEqual([...said].sort((a, b) => a - b), said);
});

// protects=self-hosters know everything a Gemini key sends; fails_when=the privacy notes leave out
// Splitwise expense descriptions, which post-sync also sends (categorizeSplitwise) (polish 5, item 7)
test('both Gemini privacy notes mention Splitwise', () => {
  const readmeRow = read('README.md').split('\n').find((l) => l.startsWith('| [Gemini API key]'));
  assert.match(readmeRow, /Splitwise/);
  const installer = read('installer/index.js');
  const note = installer.slice(installer.indexOf("console.log('Privacy:"), installer.indexOf('opts you out'));
  assert.match(note, /Splitwise/);
});
