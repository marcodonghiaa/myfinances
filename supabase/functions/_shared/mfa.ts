// Edge functions that act with the service role bypass RLS, so they check two-step sign-in
// themselves: a session that skipped the authenticator code gets nothing (migration
// 20261210000001). Fails closed: an error reads as "not satisfied".
export type RpcClient = { rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }> };

export async function mfaSatisfied(asUser: RpcClient): Promise<boolean> {
  const { data, error } = await asUser.rpc("mfa_satisfied");
  return !error && data === true;
}

export const MFA_REQUIRED = { error: "Enter your authenticator code first" } as const;
