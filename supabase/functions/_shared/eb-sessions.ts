// Enable Banking sessions: closing them, so a bank stops sharing data with this app. Used when
// a link is refused (burnCode) and when a user deletes their account (closeSessions).
import { signEnableBankingJwt } from "./enable-banking.ts";
import { errorTag } from "./log-safe.ts";

// A code whose link was refused (another user's state, or expired) must not stay redeemable:
// whoever obtained it could pair it with a state of their own. Exchange it and close the session
// straight away. Best effort: Enable Banking codes are short-lived anyway.
export async function burnCode(
  code: string,
  fetchFn: typeof fetch = fetch,
  sign: () => Promise<string> = signEnableBankingJwt,
): Promise<void> {
  try {
    const token = await sign();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const res = await fetchFn("https://api.enablebanking.com/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && typeof data.session_id === "string") {
      await fetchFn(`https://api.enablebanking.com/sessions/${encodeURIComponent(data.session_id)}`, {
        method: "DELETE",
        headers,
      });
    }
  } catch (err) {
    console.error(`refused code not closed: ${errorTag(err)}`);
  }
}

// Closes Enable Banking sessions so the bank stops sharing data with this app. Best effort per
// session: one that is already closed or expired is not an error worth stopping for.
export async function closeSessions(
  sessionIds: string[],
  fetchFn: typeof fetch = fetch,
  sign: () => Promise<string> = signEnableBankingJwt,
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const token = await sign();
  let closed = 0;
  for (const id of sessionIds) {
    try {
      const res = await fetchFn(`https://api.enablebanking.com/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok || res.status === 404) closed++;
      else console.error(`bank session not closed: ${errorTag({ status: res.status })}`);
    } catch (err) {
      console.error(`bank session not closed: ${errorTag(err)}`);
    }
  }
  return closed;
}
