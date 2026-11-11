// Server-to-server auth with the project's secret API keys (sb_secret_...). They are not JWTs:
// the gateway's verify_jwt only understands the legacy keys, so functions called this way set
// verify_jwt = false and check the apikey header here. Kept free of Deno.env for the tests.
import { timingSafeEqual } from "jsr:@std/crypto@1.1.0/timing-safe-equal";

/** SUPABASE_SECRET_KEYS is a JSON object of named keys ({"default": "sb_secret_..."}). */
export function parseSecretKeys(json: string | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(json ?? "{}");
    // Only an object of named keys: a bare JSON string would split into one-letter "keys".
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "string" && v.length > 0),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

/** True when the apikey header is one of the keys. No keys configured: always false. */
export function hasSecretKey(req: Request, keys: Record<string, string>): boolean {
  const enc = new TextEncoder();
  const given = enc.encode(req.headers.get("apikey") ?? "");
  return Object.values(keys).some((key) => {
    const expected = enc.encode(key);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
