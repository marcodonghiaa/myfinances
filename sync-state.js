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

module.exports = { loadSyncState, saveSyncState };
