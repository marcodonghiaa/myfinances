const CHUNK_SIZE = 50; // keeps the `in (...)` request URL well under proxy limits

// One UPDATE per (account, update payload) group instead of one per row. Every statement
// keeps the is-null guard on guardColumn, so it only fills empty values and never
// overwrites something set in the meantime.
// items: [{ account_uid, entry_reference, update: {col: value, ...}, guardColumn }]
async function applyGroupedUpdates(supabase, items) {
  const groups = new Map();
  for (const { account_uid, entry_reference, update, guardColumn } of items) {
    const key = JSON.stringify([account_uid, guardColumn, update]);
    if (!groups.has(key)) groups.set(key, { account_uid, guardColumn, update, refs: [] });
    groups.get(key).refs.push(entry_reference);
  }

  for (const { account_uid, guardColumn, update, refs } of groups.values()) {
    for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
      const { error } = await supabase
        .from('transactions')
        .update(update)
        .eq('account_uid', account_uid)
        .in('entry_reference', refs.slice(i, i + CHUNK_SIZE))
        .is(guardColumn, null);
      if (error) console.error(`Failed to update ${guardColumn} for ${account_uid}:`, error.message);
    }
  }
}

module.exports = { applyGroupedUpdates };
