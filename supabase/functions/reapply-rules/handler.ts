// The reapply-rules request handler, apart from Deno.serve so it can be tested.
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { PartialApplyError, reapplyRules } from "../_shared/reapply-rules.ts";
import type { Rule } from "../_shared/rules.ts";

const FIELDS = ["creditor_name", "remittance_info", "any"];
const MODES = ["contains", "word", "exact"];
// Rules from before the 200-character cap can be longer; this only bounds the body (characters).
const MAX_TEXT = 2000;

// { retired: rule } after a delete: the rule's own fields, checked like the table checks them.
// undefined when absent, null when malformed. user_id is never taken from the body.
export function retiredFrom(body: unknown): Rule | null | undefined {
  // deno-lint-ignore no-explicit-any
  const r = (body as any)?.retired;
  if (r === undefined || r === null) return undefined;
  const ok = typeof r === "object" &&
    FIELDS.includes(r.match_field) &&
    typeof r.match_text === "string" && [...r.match_text].length <= MAX_TEXT &&
    (r.match_mode == null || MODES.includes(r.match_mode)) &&
    typeof r.set_category === "string" && r.set_category.length > 0 && r.set_category.length <= MAX_TEXT;
  if (!ok) return null;
  return { user_id: "", match_field: r.match_field, match_text: r.match_text, match_mode: r.match_mode ?? "contains", set_category: r.set_category };
}

export interface Deps {
  // Who signed this request; null for a bad or expired token, throws if auth can't be reached.
  userIdFor(authorization: string): Promise<string | null>;
  // The database's two-step sign-in check, asked with the caller's JWT: the service key below
  // skips it. null when satisfied, else the reply to send (see _shared/mfa.ts).
  mfaRefusal(authorization: string): Promise<{ body: object; status: number } | null>;
  admin(): Db; // service-role client: the user's own JWT would trip the hand-edit trigger
}

export const reapplyHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("Authorization");
  let userId: string | null = null;
  try {
    userId = authorization ? await deps.userIdFor(authorization) : null;
  } catch (err) {
    console.error(`reapply-rules auth check failed: ${errorTag(err)}`);
    return json({ error: "Sign-in check is unavailable, please try again" }, 503);
  }
  if (!userId) return json({ error: "Not signed in" }, 401);
  const refusal = await deps.mfaRefusal(authorization!);
  if (refusal) return json(refusal.body, refusal.status);

  const body = await req.json().catch(() => null); // anything but { apply: true } is a preview
  const retired = retiredFrom(body);
  if (retired === null) return json({ error: "That rule can't be checked" }, 400);
  try {
    return json(await reapplyRules(deps.admin(), userId, body?.apply === true, retired));
  } catch (err) {
    console.error(`reapply-rules failed: ${errorTag(err)}`);
    const error = err instanceof PartialApplyError
      ? "Some transactions couldn't be updated. Try again: the ones already updated stay as they are."
      : "Couldn't apply your rules, please try again";
    return json({ error }, 500);
  }
};

// Reads auth.getUser()'s result: the user's id; null when the token is bad, expired or missing
// (auth answers 4xx); throws when auth is down or unreachable (5xx, network: status 0 or none).
export function userIdFrom(result: {
  data: { user: { id: string } | null };
  error: { status?: number } | null;
}): string | null {
  const { data, error } = result;
  if (error && !(error.status && error.status < 500)) throw error;
  return error ? null : data.user?.id ?? null;
}
