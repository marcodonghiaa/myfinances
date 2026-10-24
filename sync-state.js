const fs = require('fs');

// Per-account sync cursors. A missing or corrupt file just means "start from the
// default window": the upsert dedupes, so re-fetching is safe, crashing is not.
function loadSyncState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Ignoring unreadable ${file}: ${err.message}`);
    return {};
  }
}

// Write then rename so a crash mid-write can't leave a half-written cursor file.
function saveSyncState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// A bank linked in the last `windowMs` that has no cursor yet. The first-sync watcher
// only retries inside the window, so an account whose first sync keeps failing doesn't
// hit the bank every few minutes forever; the regular 6-hour sync still covers it.
function freshUnsyncedAccounts(accounts, state, now, windowMs) {
  return accounts.filter((a) => !state[a.uid] && now - Date.parse(a.created_at) <= windowMs);
}

// Accounts that got their first cursor between two reads of the state file.
function addedCursors(before, after) {
  return Object.keys(after).filter((uid) => !before[uid]);
}

// Cursors live in public.sync_cursors, so a run on a fresh machine (GitHub Actions, a new
// container) carries on where the last one stopped. The local file stays as a copy: an old
// install's cursors are read from it once, and it keeps working if the table isn't there yet.
async function loadCursors(supabase, file) {
  const fromFile = loadSyncState(file);
  const { data, error } = await supabase.from('sync_cursors').select('account_uid, last_synced');
  if (error) {
    console.warn(`Reading sync cursors from ${file} only: ${error.message}. Apply the latest migrations.`);
    return fromFile;
  }
  return { ...fromFile, ...Object.fromEntries(data.map((r) => [r.account_uid, r.last_synced])) };
}

async function saveCursors(supabase, file, state) {
  saveSyncState(file, state);
  const rows = Object.entries(state).map(([account_uid, last_synced]) => ({ account_uid, last_synced }));
  if (rows.length === 0) return;
  const { error } = await supabase.from('sync_cursors').upsert(rows, { onConflict: 'account_uid' });
  if (error) console.warn(`Sync cursors saved to ${file} only: ${error.message}`);
}

module.exports = { loadSyncState, saveSyncState, loadCursors, saveCursors, freshUnsyncedAccounts, addedCursors };
