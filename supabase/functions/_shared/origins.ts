// Which browser origins the dashboard-facing Edge Functions answer, and where the bank redirect lands.
// The dashboard registers its own address on the owner's sign-in (register_dashboard_origin(), table
// dashboard_origins). A FRONTEND_URL secret, set by older setups or `setup.sh --dashboard-url`, is still
// accepted as an extra origin. A failed lookup falls back to that secret alone: never open, never a crash.

type OriginLoader = () => Promise<string[]>;

export function legacyOrigin(): string | null {
  const raw = Deno.env.get("FRONTEND_URL");
  // Browsers compare Origin exactly, so a trailing slash in the secret would block every request.
  return raw ? raw.replace(/\/+$/, "") : null;
}

async function loadRegisteredOrigins(): Promise<string[]> {
  const { createClient } = await import("jsr:@supabase/supabase-js@2");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await supabase.from("dashboard_origins").select("origin").order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { origin: string }) => row.origin);
}

async function allowedOrigins(load: OriginLoader): Promise<string[]> {
  const registered = await load().catch((err) => {
    console.error("dashboard_origins lookup failed:", (err as Error).message);
    return [] as string[];
  });
  const legacy = legacyOrigin();
  return legacy && !registered.includes(legacy) ? [...registered, legacy] : registered;
}

/** The request's Origin when it is an allowed dashboard origin, else null. */
export function pickAllowedOrigin(requestOrigin: string | null, allowed: string[]): string | null {
  return requestOrigin !== null && allowed.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Where bank-consent-callback sends the browser: the origin that started the link if it is still
 * allowed (never anything from the callback URL), else the legacy secret, else the first registered one.
 */
export function pickRedirectOrigin(stored: string | null, allowed: string[], legacy: string | null): string | null {
  if (stored && allowed.includes(stored)) return stored;
  return legacy ?? allowed[0] ?? null;
}

export async function redirectOrigin(stored: string | null, load: OriginLoader = loadRegisteredOrigins) {
  return pickRedirectOrigin(stored, await allowedOrigins(load), legacyOrigin());
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export type Reply = (body: unknown, status?: number) => Response;

/** Deno.serve handler: answers the CORS preflight and hands `handler` a reply() carrying the CORS headers. */
export function serveWithCors(
  handler: (req: Request, reply: Reply, origin: string | null) => Promise<Response>,
  load: OriginLoader = loadRegisteredOrigins,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const origin = pickAllowedOrigin(req.headers.get("Origin"), await allowedOrigins(load));
    const headers = corsHeaders(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const reply: Reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
    return await handler(req, reply, origin);
  };
}
