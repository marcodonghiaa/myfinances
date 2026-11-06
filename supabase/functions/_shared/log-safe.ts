// What may be logged about an error: a code, an HTTP status or a class name. Never the
// message: it can carry names, IBANs, amounts or a raw response body.
export function errorTag(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string" && e.code) return e.code;
  if (typeof e?.status === "number") return `HTTP ${e.status}`;
  if (typeof e?.name === "string") return e.name;
  return "Error";
}
