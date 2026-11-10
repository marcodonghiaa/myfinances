// Supabase Edge Function: parse-statement
//
// Reads the transactions out of a bank statement PDF for the dashboard's import:
// { pdf: <base64> } -> { rows: [{ date, description, amount, direction }] }.
// The PDF goes to Gemini (the same API the categorizer uses) and is never stored. Nothing is
// written here: the dashboard shows the rows, leaves out ones already imported, and adds the
// rest with add_manual_transaction once you confirm.
//
// Requires a signed-in user, or this is an open proxy to Gemini on your key.
// Secret: GEMINI_API_KEY (and optionally GEMINI_MODEL).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/origins.ts";
import { errorTag } from "../_shared/log-safe.ts";
import { geminiRequest, parseGeminiRows, parseStatementRequest } from "../_shared/statement-pdf.ts";
import { mfaRefusal } from "../_shared/mfa.ts";

const TIMEOUT_MS = 90_000;

Deno.serve(serveWithCors(async (req, json) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Not signed in" }, 401);
  const mfa = await mfaRefusal(userClient);
  if (mfa) return json(mfa.body, mfa.status);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ error: "PDF import needs the GEMINI_API_KEY secret on the Edge Functions" }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseStatementRequest(body);
  if (typeof parsed === "string") return json({ error: parsed }, 400);

  const model = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(geminiRequest(parsed.pdf)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Gemini did not answer: ${errorTag(err)}`);
    return json({ error: "The AI didn't answer in time, try a shorter statement" }, 504);
  }
  if (!res.ok) {
    // The body can quote the request; keep it out of the browser and the log.
    console.error(`Gemini error ${res.status}`);
    return json({ error: `The AI couldn't read this PDF (error ${res.status})` }, 502);
  }
  return json({ rows: parseGeminiRows(await res.json()) });
}));
