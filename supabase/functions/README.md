# Supabase Edge Functions

Source of truth for the three functions backing self-serve bank linking.
Deployed manually via the Supabase MCP tooling (`deploy_edge_function`), not
by a CI pipeline or `supabase functions deploy` — if you edit these files,
redeploy them the same way, or the live functions will drift from this repo.

- **start-bank-consent** — signs an Enable Banking consent request for the
  logged-in user, returns the URL to redirect the browser to. `verify_jwt: true`.
- **bank-consent-callback** — the redirect target Enable Banking sends the
  user back to after consent. Exchanges the code, saves the discovered
  accounts. `verify_jwt: false` (it's a bank's plain browser redirect, no
  Authorization header).
- **list-banks** — read-only lookup of Enable Banking's supported banks for
  a country, powers the bank picker. `verify_jwt: true`.

## Secrets

Set once in the Supabase Dashboard (Project Settings → Edge Functions →
Secrets), not committed anywhere:

- `ENABLE_BANKING_APP_ID`
- `ENABLE_BANKING_PRIVATE_KEY` (the full PEM, same key the local CLI scripts use)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected by Supabase into every function; nothing to set for those.
