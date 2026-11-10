// Deno port of batch-update.js, shared by the post-sync steps.
import { errorTag } from "./log-safe.ts";

// deno-lint-ignore no-explicit-any
export type Db = { from(table: string): any };

export interface RowUpdate {
  account_uid: string;
  entry_reference: string;
  update: Record<string, unknown>;
  guardColumn: string;
  guardIn?: string[];
  guardOrNull?: boolean; // with guardIn: also rows where guardColumn is null
}

const CHUNK_SIZE = 50; // keeps the `in (...)` request URL well under proxy limits

// One UPDATE per (account, update payload) group instead of one per row. Every statement
// is guarded on guardColumn: is-null by default (only fills empty values), or an in-list
// when guardIn is given (e.g. only rows whose category_source is ai/rule), or-null with guardOrNull.
export async function applyGroupedUpdates(db: Db, items: RowUpdate[]): Promise<void> {
  const groups = new Map<string, Omit<RowUpdate, "entry_reference"> & { refs: string[] }>();
  for (const { account_uid, entry_reference, update, guardColumn, guardIn, guardOrNull } of items) {
    const key = JSON.stringify([account_uid, guardColumn, guardIn, guardOrNull, update]);
    if (!groups.has(key)) groups.set(key, { account_uid, guardColumn, guardIn, guardOrNull, update, refs: [] });
    groups.get(key)!.refs.push(entry_reference);
  }

  for (const { account_uid, guardColumn, guardIn, guardOrNull, update, refs } of groups.values()) {
    for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
      const query = db
        .from("transactions")
        .update(update)
        .eq("account_uid", account_uid)
        .in("entry_reference", refs.slice(i, i + CHUNK_SIZE));
      const guarded = !guardIn
        ? query.is(guardColumn, null)
        : guardOrNull
        ? query.or(`${guardColumn}.is.null,${guardColumn}.in.(${guardIn.join(",")})`)
        : query.in(guardColumn, guardIn);
      const { error } = await guarded;
      if (error) console.error(`Failed to update ${guardColumn} for one account: ${errorTag(error)}`);
    }
  }
}
