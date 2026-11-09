// Consumes the single-use pending_bank_consents row for a bank link, through the caller's own
// session: RLS lets a user delete only their own rows, so a state minted by someone else is
// simply not found. The user_id check repeats that in code, in case a service client is passed.

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

const CONSENT_WINDOW_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INVALID_CONSENT = "Invalid or expired consent request";
export const EXPIRED_CONSENT = "Consent request expired, please try again";

export function isConsentInput(body: unknown): body is { code: string; state: string } {
  const b = body as { code?: unknown; state?: unknown } | null;
  return typeof b?.code === "string" && b.code.length > 0 && b.code.length <= 2048 &&
    typeof b?.state === "string" && UUID.test(b.state);
}

export async function claimConsent(
  db: Db,
  state: string,
  userId: string,
  now: number,
): Promise<{ ok: true } | { error: string }> {
  const { data, error } = await db
    .from("pending_bank_consents")
    .delete()
    .eq("id", state)
    .select("user_id, created_at")
    .maybeSingle();
  if (error || !data || data.user_id !== userId) return { error: INVALID_CONSENT };
  if (now - new Date(data.created_at).getTime() > CONSENT_WINDOW_MS) return { error: EXPIRED_CONSENT };
  return { ok: true };
}
