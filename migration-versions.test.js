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
