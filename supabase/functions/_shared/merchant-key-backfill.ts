// Fills merchant_key where it is missing (rows from before the sync wrote it, or whose
// creditor_name changed) and folds aliases that now share a key into the newest one.
// Aggregator keys (PayPal, Apple, Google) span unrelated payees: rows store them, but they
// never pick up an alias by key, and aliases named after them stay unkeyed and are never merged.
import { applyGroupedUpdates, type Db } from "./batch-update.ts";
import { errorTag } from "./log-safe.ts";
import { normalizeMerchant } from "./merchant-key.ts";

const PAGE_SIZE = 1000; // PostgREST caps a response at 1000 rows

type Alias = { user_id: string; source_name: string; alias: string; merchant_key: string | null; created_at: string };
type TxRow = { user_id: string; account_uid: string; entry_reference: string; creditor_name: string; custom_name: string | null };

// Returns the surviving aliases, newest first per (user, key), keyed as "user|key".
async function keyAliases(db: Db): Promise<{ count: number; byKey: Map<string, Alias> }> {
  // shortcut: one page of aliases (1000), plenty for one person; page it if users ever add more.
  const { data, error } = await db
    .from("merchant_aliases")
    .select("user_id, source_name, alias, merchant_key, created_at")
    .order("created_at", { ascending: false })
    .order("source_name");
  if (error) throw error;

  const byKey = new Map<string, Alias>();
  const losers = new Map<string, string[]>();
  const toKey: Alias[] = [];
  for (const a of data as Alias[]) {
    const n = normalizeMerchant(a.source_name);
    const key = a.merchant_key ?? (n.aggregator ? null : n.key);
    if (!key || n.aggregator) continue;
    const id = `${a.user_id}|${key}`;
    if (byKey.has(id)) losers.set(a.user_id, [...(losers.get(a.user_id) ?? []), a.source_name]);
    else {
      byKey.set(id, { ...a, merchant_key: key });
      if (!a.merchant_key) toKey.push({ ...a, merchant_key: key });
    }
  }

  for (const [user, names] of losers) {
    const { error } = await db.from("merchant_aliases").delete().eq("user_id", user).in("source_name", names);
    if (error) console.error(`Failed to remove ${names.length} duplicate alias(es): ${errorTag(error)}`);
  }
  for (const a of toKey) {
    const { error } = await db
      .from("merchant_aliases")
      .update({ merchant_key: a.merchant_key })
      .eq("user_id", a.user_id)
      .eq("source_name", a.source_name)
      .is("merchant_key", null);
    if (error) console.error(`Failed to key an alias: ${errorTag(error)}`);
  }
  return { count: toKey.length, byKey };
}

async function fetchUnkeyed(db: Db, limit: number): Promise<TxRow[]> {
  const rows: TxRow[] = [];
  for (let from = 0; from < limit; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("transactions")
      .select("user_id, account_uid, entry_reference, creditor_name, custom_name")
      .is("merchant_key", null)
      .not("creditor_name", "is", null)
      .order("entry_reference")
      .range(from, Math.min(from + PAGE_SIZE, limit) - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

export async function fillMerchantKeys(db: Db, timeLeft: () => boolean, limit = 2000) {
  if (!timeLeft()) return { keys: 0, aliases: 0 };
  const { count: aliases, byKey } = await keyAliases(db);
  if (!timeLeft()) return { keys: 0, aliases };

  // shortcut: a name that normalizes to no key (punctuation only) is refetched every run; harmless until thousands pile up.
  const updates = (await fetchUnkeyed(db, limit)).flatMap((row) => {
    const { key, aggregator } = normalizeMerchant(row.creditor_name);
    if (!key) return [];
    const alias = !aggregator && row.custom_name === null ? byKey.get(`${row.user_id}|${key}`)?.alias : undefined;
    return [{
      account_uid: row.account_uid,
      entry_reference: row.entry_reference,
      update: alias ? { merchant_key: key, custom_name: alias } : { merchant_key: key },
      guardColumn: "merchant_key",
    }];
  });
  await applyGroupedUpdates(db, updates);
  return { keys: updates.length, aliases };
}
