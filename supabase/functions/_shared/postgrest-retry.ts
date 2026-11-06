// With a secret key (sb_secret_...) the gateway mints a short-lived JWT for every database
// request. Under parallel load PostgREST sometimes refuses that token (401, code PGRST303), as in
// 1 of 10 parallel sync-bank calls on 2026-11-06 UTC. The request never ran, so sending it once more
// (with a freshly minted token) is safe for reads and writes alike.
export function retryRejectedToken(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await fetchFn(input, init);
    if (res.status !== 401) return res;
    const body = await res.clone().json().catch(() => null);
    return body?.code === "PGRST303" ? fetchFn(input, init) : res;
  };
}
