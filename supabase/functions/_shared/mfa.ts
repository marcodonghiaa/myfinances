// Edge functions that act with the service role skip the database's two-step sign-in check
// (migration 20261203000000), so they ask it themselves with the caller's JWT. Fails closed:
// at aal1 the database refuses the call (42501) → 403; any other error → 503, logged.
export type RpcClient = {
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

export async function mfaRefusal(asUser: RpcClient): Promise<{ body: object; status: number } | null> {
  const { data, error } = await asUser.rpc("mfa_satisfied");
  if (!error && data === true) return null;
  if (!error || error.code === "42501") {
    return { body: { error: "Enter your authenticator code first", code: "mfa_required" }, status: 403 };
  }
  console.error("mfa_satisfied failed", error.code, error.message);
  return { body: { error: "Server update incomplete: apply the latest database migration" }, status: 503 };
}
