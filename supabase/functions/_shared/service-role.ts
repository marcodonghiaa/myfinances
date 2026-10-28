// True when the request carries a JWT whose role claim is service_role.
// No signature check here on purpose: verify_jwt = true (config.toml) makes the gateway
// verify the signature before the function runs, and anon / user tokens carry other roles.
export function isServiceRole(req: Request): boolean {
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.[\w-]+$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return false;
  try {
    const b64 = match[2].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}
