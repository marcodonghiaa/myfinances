# Supabase Edge Functions

Source of truth for the three functions backing self-serve bank linking.
Deploy with `supabase functions deploy --project-ref <ref>` (what `setup.sh`
runs) — `verify_jwt` per function is codified in `supabase/config.toml`, so a
plain deploy from this repo reproduces the same gating described below.

- **start-bank-consent** — signs an Enable Banking consent request for the
  logged-in user, returns the URL to redirect the browser to. `verify_jwt: true`.
- **bank-consent-callback** — the redirect target Enable Banking sends the
  user back to after consent. Exchanges the code, saves the discovered
  accounts. `verify_jwt: false` (it's a bank's plain browser redirect, no
  Authorization header).
- **list-banks** — read-only lookup of Enable Banking's supported banks for
  a country, powers the bank picker. `verify_jwt: true`.

## Secrets

Set once via `supabase secrets set --project-ref <ref> KEY=value` (what
`setup.sh` runs), or in the Supabase Dashboard (Project Settings → Edge
Functions → Secrets). Never committed anywhere:

- `ENABLE_BANKING_APP_ID`
- `ENABLE_BANKING_PRIVATE_KEY` (the full PEM, same key the local CLI scripts use)
- `FRONTEND_URL` — where `bank-consent-callback` redirects the browser after
  linking a bank, and the CORS origin for `list-banks`/`start-bank-consent`.
  Your deployed frontend's URL (e.g. `http://localhost:3000` for a local
  Docker setup, or your real domain if deployed elsewhere).

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected by Supabase into every function; nothing to set for those.
