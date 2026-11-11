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
  alsoIn?: [string, string[]]; // a second in-list guard, e.g. flow_type as well as flow_source
  // An exact-value guard, for values that come from a request: postgrest-js doesn't escape a
  // quote inside an in() value, so `x","y` would become two values there.
  alsoEq?: [string, string];
}

const CHUNK_SIZE = 50; // keeps the `in (...)` request URL well under proxy limits

// One UPDATE per (account, update payload) group instead of one per row. Every statement
// is guarded on guardColumn: is-null by default (only fills empty values), or an in-list
// when guardIn is given (e.g. only rows whose category_source is ai/rule). userId also scopes
// every statement to that user, for callers that write with the service key on a user's
// behalf. Returns how many statements failed (each one is logged).
export async function applyGroupedUpdates(db: Db, items: RowUpdate[], userId?: string): Promise<number> {
  const groups = new Map<string, Omit<RowUpdate, "entry_reference"> & { refs: string[] }>();
  for (const { account_uid, entry_reference, update, guardColumn, guardIn, alsoIn, alsoEq } of items) {
    const key = JSON.stringify([account_uid, guardColumn, guardIn, alsoIn, alsoEq, update]);
    if (!groups.has(key)) groups.set(key, { account_uid, guardColumn, guardIn, alsoIn, alsoEq, update, refs: [] });
    groups.get(key)!.refs.push(entry_reference);
  }

  let failed = 0;
  for (const { account_uid, guardColumn, guardIn, alsoIn, alsoEq, update, refs } of groups.values()) {
    for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
      let query = db
        .from("transactions")
        .update(update)
        .eq("account_uid", account_uid)
        .in("entry_reference", refs.slice(i, i + CHUNK_SIZE));
      if (userId) query = query.eq("user_id", userId);
      if (alsoIn) query = query.in(alsoIn[0], alsoIn[1]);
      if (alsoEq) query = query.eq(alsoEq[0], alsoEq[1]);
      const { error } = await (guardIn ? query.in(guardColumn, guardIn) : query.is(guardColumn, null));
      if (error) {
        failed++;
        console.error(`Failed to update ${guardColumn} for one account: ${errorTag(error)}`);
      }
    }
  }
  return failed;
}
