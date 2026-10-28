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
- **add-holding** — searches Yahoo Finance (stocks, ETFs, funds) or CoinGecko
  (crypto) by name, ticker or ISIN, and adds the chosen holding with today's
  price so it shows at once. Writes the holding as the user (RLS), the price
  with the service role. `verify_jwt: true`.
- **list-banks** — read-only lookup of Enable Banking's supported banks for
  a country, powers the bank picker. `verify_jwt: true`.
- **sync-bank** — P2 spike: syncs balance and transactions for one account
  (`{"account_uid": "..."}`), the Deno port of `sync-networth.js` +
  `sync-transactions.js`. Service role only (checked in the function on top of
  `verify_jwt: true`). Never run it beside the launchd/Docker sync: banks allow
  ~4 unattended calls a day per account.

## Secrets

Set once via `supabase secrets set --project-ref <ref> KEY=value` (what
`setup.sh` runs), or in the Supabase Dashboard (Project Settings → Edge
Functions → Secrets). Never committed anywhere:

- `ENABLE_BANKING_APP_ID`
- `ENABLE_BANKING_PRIVATE_KEY` (the full PEM, same key the local CLI scripts use)
- `FRONTEND_URL` (optional) — an extra allowed dashboard origin, kept for older setups and
  `./setup.sh --dashboard-url`. Normally unneeded: the dashboard registers its own address
  (table `dashboard_origins`) when you sign in, and the functions allow those origins in CORS.
  `bank-consent-callback` sends the browser back to the origin that started the link.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected by Supabase into every function; nothing to set for those.
