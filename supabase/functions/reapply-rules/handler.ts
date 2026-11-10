// The reapply-rules request handler, apart from Deno.serve so it can be tested.
import type { Db } from "../_shared/batch-update.ts";
import type { Reply } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { PartialApplyError, reapplyRules } from "../_shared/reapply-rules.ts";

export interface Deps {
  userIdFor(authorization: string): Promise<string | null>; // who signed this request, or null
  admin(): Db; // service-role client: the user's own JWT would trip the hand-edit trigger
}

export const reapplyHandler = (deps: Deps) => async (req: Request, json: Reply): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("Authorization");
  const userId = authorization ? await deps.userIdFor(authorization) : null;
  if (!userId) return json({ error: "Not signed in" }, 401);

  const body = await req.json().catch(() => null); // anything but { apply: true } is a preview
  try {
    return json(await reapplyRules(deps.admin(), userId, body?.apply === true));
  } catch (err) {
    console.error(`reapply-rules failed: ${errorTag(err)}`);
    const error = err instanceof PartialApplyError
      ? "Some transactions couldn't be updated. Try again: the ones already updated stay as they are."
      : "Couldn't apply your rules, please try again";
    return json({ error }, 500);
  }
};
