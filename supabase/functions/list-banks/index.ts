// Supabase Edge Function: list-banks
//
// Powers the bank picker on the Accounts page -- given a country, returns
// Enable Banking's real list of supported banks (ASPSPs) so the user picks
// from a dropdown instead of typing a bank name that has to match exactly.
// Same JWT-signing as start-bank-consent/bank-consent-callback; no writes,
// read-only lookup.
//
// Requires a signed-in user -- otherwise this is an unauthenticated proxy to
// the operator's Enable Banking credentials/quota. verify_jwt is also set in
// supabase/config.toml as a gateway-level backstop; this in-function check is
// the one that's actually reproducible from a plain `supabase functions deploy`.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS_HEADERS, json, signEnableBankingJwt } from "../_shared/enable-banking.ts";

interface Aspsp {
  name: string;
  country: string;
  logo?: string | null;
  beta?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: "Not signed in" }, 401);
  }

  let body: { country?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.country) {
    return json({ error: "country is required" }, 400);
  }

  try {
    const token = await signEnableBankingJwt();
    const res = await fetch(
      `https://api.enablebanking.com/aspsps?country=${encodeURIComponent(body.country)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    if (!res.ok) {
      return json({ error: "Enable Banking error", detail: data }, 502);
    }

    const banks = ((data.aspsps ?? []) as Array<Aspsp>)
      .filter((a) => !a.beta)
      .map((a) => ({ name: a.name, logo: a.logo ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return json({ banks });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
