// Supabase Edge Function: start-bank-consent
//
// First step of self-serve bank linking. Given a bank name + country, signs
// the Enable Banking RS256 JWT server-side (same logic as the local
// start-auth.js CLI script, just moved off the Mac) and returns the consent
// URL the user's browser should be redirected to.
//
// Called via supabase.functions.invoke from the browser, so it needs real
// CORS handling -- the browser preflights with OPTIONS before the actual
// POST, and without an explicit 200 + Allow-* response there the request
// never leaves the browser at all ("Failed to send a request").

import { createClient } from "jsr:@supabase/supabase-js@2";

const ENABLE_BANKING_APP_ID = Deno.env.get("ENABLE_BANKING_APP_ID")!;
const ENABLE_BANKING_PRIVATE_KEY = Deno.env.get("ENABLE_BANKING_PRIVATE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(der);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signEnableBankingJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "RS256", kid: ENABLE_BANKING_APP_ID };
  const payload = {
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await importPrivateKey(ENABLE_BANKING_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
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

  let body: { bankName?: string; country?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.bankName || !body.country) {
    return json({ error: "bankName and country are required" }, 400);
  }

  // Enable Banking treats `state` as an opaque pass-through it never
  // validates -- a bare user id there would let anyone who completes their
  // own consent hand-edit state to a victim's id before hitting the
  // callback. Issue a single-use, unguessable token instead; the callback
  // looks up the real user id by it and deletes the row.
  const { data: pending, error: pendingError } = await supabase
    .from("pending_bank_consents")
    .insert({ user_id: userData.user.id })
    .select("id")
    .single();
  if (pendingError || !pending) {
    return json({ error: "Couldn't start consent" }, 500);
  }

  try {
    const token = await signEnableBankingJwt();
    const res = await fetch("https://api.enablebanking.com/auth", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        access: { valid_until: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString() },
        aspsp: { name: body.bankName, country: body.country },
        state: pending.id,
        redirect_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/bank-consent-callback`,
        psu_type: "personal",
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.url) {
      return json({ error: "Enable Banking error", detail: data }, 502);
    }
    return json({ url: data.url });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
