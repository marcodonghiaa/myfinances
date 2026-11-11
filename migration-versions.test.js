const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// Supabase records each migration by the number before the first "_": two files with the same
// number make `supabase db push` stop half-way on a fresh install (duplicate key in schema_migrations).
test('every migration has its own version number', () => {
  const versions = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).map((f) => f.split('_')[0]);
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual(dupes, []);
});

// polish-5 #2: a self-hoster only learns what to run, and in which order, from UPGRADING.md.
test('migrations from 20261127 on (when release notes started) are named in UPGRADING.md with a deploy order', () => {
  const notes = fs.readFileSync('UPGRADING.md', 'utf8');
  const recent = fs.readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql') && f.split('_')[0] >= '20261127000000')
    .map((f) => f.replace(/\.sql$/, ''));
  assert.deepEqual(recent.filter((name) => !notes.includes(`\`${name}\``)), [], 'missing from UPGRADING.md');
  assert.match(notes, /dashboard first/i);
});
