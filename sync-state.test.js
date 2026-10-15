const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSyncState, saveSyncState } = require('./sync-state');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-')), 'last-sync.json');

test('a missing file means no cursors yet', () => {
  assert.deepStrictEqual(loadSyncState(tmpFile()), {});
});

test('saved state loads back unchanged', () => {
  const file = tmpFile();
  saveSyncState(file, { acc1: '2026-10-01' });
  assert.deepStrictEqual(loadSyncState(file), { acc1: '2026-10-01' });
});

test('a corrupt file falls back to empty state instead of crashing the sync', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"acc1": "2026-10');
  assert.deepStrictEqual(loadSyncState(file), {});
});

test('saving leaves no temp file behind and replaces old content', () => {
  const file = tmpFile();
  saveSyncState(file, { a: '1' });
  saveSyncState(file, { b: '2' });
  assert.deepStrictEqual(loadSyncState(file), { b: '2' });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['last-sync.json']);
});
