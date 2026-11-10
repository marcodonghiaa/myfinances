// Supabase Edge Function: reapply-rules
//
// The Rules page's "Apply to past transactions". Body: { "apply": false } previews how many
// transactions your current rules would re-categorize (plus a few examples); { "apply": true }
// does it. The caller's JWT only identifies them; reads and writes use the service key, each
// scoped to that user, because a write with the user's JWT would mark every changed row as
// hand-set (trg_mark_manual_category). Categories you set by hand are never changed (see
// _shared/reapply-rules.ts).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { reapplyHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;

Deno.serve(serveWithCors(reapplyHandler({
  async userIdFor(authorization) {
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authorization } } });
    const { data, error } = await asUser.auth.getUser();
    if (error && !(error.status && error.status < 500)) throw error; // auth down or unreachable
    return error ? null : data.user?.id ?? null;
  },
  admin: () => createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
})));
