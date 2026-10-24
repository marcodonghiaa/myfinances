const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSyncState, saveSyncState, freshUnsyncedAccounts, addedCursors } = require('./sync-state');

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

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000).toISOString();

test('an account linked minutes ago with no cursor is picked up by the first-sync watcher', () => {
  const accounts = [{ uid: 'new', created_at: minutesAgo(10) }];
  assert.deepStrictEqual(freshUnsyncedAccounts(accounts, {}, NOW, HOUR), accounts);
});

test('an account that already has a cursor is left to the regular sync', () => {
  const accounts = [{ uid: 'old', created_at: minutesAgo(10) }];
  assert.deepStrictEqual(freshUnsyncedAccounts(accounts, { old: '2026-10-23' }, NOW, HOUR), []);
});

test('an account whose first sync keeps failing stops being retried after the window', () => {
  const accounts = [{ uid: 'stuck', created_at: minutesAgo(90) }];
  assert.deepStrictEqual(freshUnsyncedAccounts(accounts, {}, NOW, HOUR), []);
});

test('addedCursors lists only accounts that got their first cursor', () => {
  assert.deepStrictEqual(addedCursors({ a: '2026-10-22' }, { a: '2026-10-23', b: '2026-10-23' }), ['b']);
  assert.deepStrictEqual(addedCursors({ a: '2026-10-22' }, { a: '2026-10-23' }), []);
});

const { loadCursors, saveCursors } = require('./sync-state');

// Minimal stand-in for the two calls the cursor table needs.
function fakeDb({ rows = [], error = null } = {}) {
  const upserts = [];
  return {
    upserts,
    from: () => ({
      select: async () => ({ data: error ? null : rows, error }),
      upsert: async (r, opts) => {
        upserts.push({ rows: r, opts });
        return { error };
      },
    }),
  };
}

test('cursors come from the database, which wins over an old local file', async () => {
  const file = tmpFile();
  saveSyncState(file, { a: '2026-10-01', b: '2026-10-02' });
  const db = fakeDb({ rows: [{ account_uid: 'a', last_synced: '2026-10-20' }] });
  assert.deepStrictEqual(await loadCursors(db, file), { a: '2026-10-20', b: '2026-10-02' });
});

test('saving writes every cursor to the database and keeps the local file as a copy', async () => {
  const file = tmpFile();
  const db = fakeDb();
  await saveCursors(db, file, { a: '2026-10-20' });
  assert.deepStrictEqual(db.upserts[0].rows, [{ account_uid: 'a', last_synced: '2026-10-20' }]);
  assert.strictEqual(db.upserts[0].opts.onConflict, 'account_uid');
  assert.deepStrictEqual(loadSyncState(file), { a: '2026-10-20' });
});

test('without the cursor table (migration not applied yet) the file still works', async () => {
  const file = tmpFile();
  saveSyncState(file, { a: '2026-10-01' });
  const db = fakeDb({ error: { message: 'relation "sync_cursors" does not exist' } });
  assert.deepStrictEqual(await loadCursors(db, file), { a: '2026-10-01' });
  await saveCursors(db, file, { a: '2026-10-21' });
  assert.deepStrictEqual(loadSyncState(file), { a: '2026-10-21' });
});
