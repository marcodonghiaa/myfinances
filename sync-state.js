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

module.exports = { loadSyncState, saveSyncState, freshUnsyncedAccounts, addedCursors };
