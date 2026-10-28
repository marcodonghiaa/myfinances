// Shared by the bank-linking Edge Functions: signs the RS256 JWT Enable Banking
// expects on every API call. CORS and the JSON reply helper live in origins.ts.

const ENABLE_BANKING_APP_ID = Deno.env.get("ENABLE_BANKING_APP_ID")!;
const ENABLE_BANKING_PRIVATE_KEY = Deno.env.get("ENABLE_BANKING_PRIVATE_KEY")!;

export const EB_KEY_INVALID = "The Enable Banking key is invalid: run ./setup.sh again with the .pem.";
export const EB_NO_ACCOUNTS =
  "Enable Banking didn't share any accounts. Link this bank once on enablebanking.com → API applications → your app → Link accounts, then try again.";

// 401/403 from Enable Banking means the app itself was refused (left Inactive, or wrong key id).
export function ebErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "Your Enable Banking app was rejected: activate it (link one of your accounts on enablebanking.com → API applications), and check the key setup gave it.";
  }
  return "Enable Banking error, please try again";
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

export async function signEnableBankingJwt(): Promise<string> {
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
