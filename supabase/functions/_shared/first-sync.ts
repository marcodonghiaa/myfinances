// The cron syncs banks every 6 hours, so a bank linked just after a run showed no transactions
// for hours. Right after a link, ask sync-bank (the same function the cron calls, with the same
// secret key) to sync each new account once. Best effort: a failure waits for the next cron run.
import { errorTag } from "./log-safe.ts";

export async function startFirstSync(
  baseUrl: string,
  secretKey: string | undefined,
  accountUids: string[],
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  if (!secretKey) return 0;
  const results = await Promise.all(accountUids.map(async (uid) => {
    try {
      const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/functions/v1/sync-bank`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: secretKey },
        body: JSON.stringify({ account_uid: uid }),
      });
      await res.body?.cancel();
      if (!res.ok) console.error(`first sync failed: ${errorTag({ status: res.status })}`);
      return res.ok;
    } catch (err) {
      console.error(`first sync failed: ${errorTag(err)}`);
      return false;
    }
  }));
  return results.filter(Boolean).length;
}
