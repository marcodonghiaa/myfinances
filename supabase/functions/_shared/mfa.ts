// Edge functions that act with the service role skip the database's two-step sign-in check
// (migration 20261203000000), so they ask it themselves with the caller's JWT. Fails closed:
// at aal1 the database refuses the call (42501); any other error is logged and refused too.
export type RpcClient = {
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

export async function mfaSatisfied(asUser: RpcClient): Promise<boolean> {
  const { data, error } = await asUser.rpc("mfa_satisfied");
  if (error && error.code !== "42501") console.error("mfa_satisfied failed", error.code, error.message);
  return !error && data === true;
}

export const MFA_REQUIRED = { error: "Enter your authenticator code first", code: "mfa_required" } as const;
