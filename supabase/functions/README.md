# Supabase Edge Functions

Source of truth for the Edge Functions: bank linking, account deletion, holdings, statements.
Deploy with `supabase functions deploy --project-ref <ref>` (what `setup.sh`
runs) — `verify_jwt` per function is codified in `supabase/config.toml`, so a
plain deploy from this repo reproduces the same gating described below.

- **start-bank-consent** — signs an Enable Banking consent request for the
  logged-in user, returns the URL to redirect the browser to. `verify_jwt: true`.
- **bank-consent-callback** — the redirect target Enable Banking sends the
  user back to after consent. Links nothing: it checks the request and sends
  the browser to the dashboard with the code. `verify_jwt: false` (it's a
  bank's plain browser redirect, no Authorization header).
- **complete-bank-consent** — called by the signed-in dashboard with that code.
  Exchanges it and saves the accounts, only for the user who started the link.
  Stores each account's type from the bank (`cash_account_type`: CACC checking, SVGS savings,
  CARD credit card, LOAN loan, anything else other). `verify_jwt: true`.
- **delete-account** — called by the signed-in dashboard with `{ "confirm": "DELETE", "password" }`;
  checks the password again before anything is deleted.
  Deletes the user (every row cascades), then closes their stored Enable Banking
  sessions. Refuses the instance owner while other users exist. `verify_jwt: true`.
- **add-holding** — searches Yahoo Finance (stocks, ETFs, funds) or CoinGecko
  (crypto) by name, ticker or ISIN, and adds the chosen holding with today's
  price so it shows at once. Writes the holding as the user (RLS), the price
  with the service role. `verify_jwt: true`.
- **reapply-rules** — the Rules page's "Apply to past transactions": `{ "apply": false }`
  previews how many transactions your rules would re-categorize (with a few examples),
  `{ "apply": true }` does it. The JWT identifies the user; reads and writes use the service key
  scoped to that user. Categories set by hand, and Transfer rows, never change.
  `verify_jwt: true`.
- **parse-statement** — reads the transactions out of a bank statement PDF with Gemini
  for the dashboard's import (`{ pdf: <base64> }` → `{ rows }`). The PDF is never stored and
  nothing is written: the dashboard adds the rows you confirm. Needs `GEMINI_API_KEY`;
  the whole PDF (name, IBAN) goes to Google, which on the free tier may use it, so prefer a
  paid-tier key.
  `verify_jwt: true`.
- **list-banks** — read-only lookup of Enable Banking's supported banks for
  a country, powers the bank picker. `verify_jwt: true`.
- **sync-bank** — P2 spike: syncs balance and transactions for one account
  (`{"account_uid": "..."}`), the Deno port of `sync-networth.js` +
  `sync-transactions.js`. Callers send a project secret key (`sb_secret_...`) on
  the `apikey` header; the function checks it against `SUPABASE_SECRET_KEYS`
  (`verify_jwt: false`, secret keys are not JWTs). A project still on the legacy
  keys only must create its secret keys first (Settings → API Keys), or every
  call gets 401. An account with no type yet gets it from the bank's
  account details once (`checking` when the bank sends none). Never run it beside the
  launchd/Docker sync: banks allow ~4 unattended calls a day per account.

- **post-sync** — what the sync pipeline runs after the bank sync, moved into
  Supabase: categories for new rows (your rules, your past choices, then Gemini;
  port of `categorize.js`), transaction types (`classify-type.js`), Splitwise
  share categories (`categorize-splitwise.js`), then `flow_type` with its
  `flow_source` (your flow rules, a Transfer category from your rules or past
  choices, a counterparty that is one of your own accounts, the bank code, then the
  direction; recent `default` rows are re-checked), suggested transfer pairs between
  your own accounts (`transfer_pairs`, same amount and currency, opposite sides,
  within 4 days, no tie; stale suggestions are removed) and refund pairs
  (`classify-flow.js`). No bank calls; it only fills empty values or changes rows
  whose `flow_source` is `default`, `bank` or `pair`, never a flow you set (`user`)
  or one from before this release (`legacy`), so it can run beside the
  launchd/Docker sync. Same auth as
  `sync-bank` (secret key on `apikey`, `verify_jwt: false`).

- **sync-prices** — today's exchange rates (Frankfurter, with a 100-day backfill
  on a fresh install), then a price snapshot for every stock/ETF (Yahoo) and coin
  (CoinGecko) holding, with the owner's Coinbase balances synced first when
  configured: port of `fx-sync.js`, `sync-portfolio-prices.js`,
  `sync-crypto-coinbase.js` and `sync-crypto-prices.js`. No bank calls; one step failing doesn't stop the
  others. Same auth as `sync-bank`.
- **notify** — push notifications: `{"job":"worth-it"}` sends the "Worth it?"
  prompts (hourly), `{"job":"consent"}` the bank-access reminders
  (daily). Port of `notify-worth-it.js`, `consent-notice.js` and `push.js`
  (web-push via npm). Same auth as `sync-bank`.

## Secrets

Set once via `supabase secrets set --project-ref <ref> KEY=value` (what
`setup.sh` runs), or in the Supabase Dashboard (Project Settings → Edge
Functions → Secrets). Never committed anywhere:

- `ENABLE_BANKING_APP_ID`
- `ENABLE_BANKING_PRIVATE_KEY` (the full PEM, same key the local CLI scripts use)
- `GEMINI_API_KEY` (for parse-statement; the same key as the sync's `.env`). Optional
  `GEMINI_MODEL`.
- `GEMINI_API_KEY`, optional `GEMINI_MODEL` (default `gemini-3.5-flash-lite`) —
  used by `post-sync` to categorize; without them only your rules and past
  choices categorize.
- `COINBASE_API_KEY_NAME`, `COINBASE_API_PRIVATE_KEY`, `COINBASE_USER_ID` —
  optional, for `sync-prices` to sync one user's Coinbase balances (the user id
  is whose holdings they are).
- `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — for `notify` to
  send push notifications; without them nothing is sent.
- `FRONTEND_URL` (optional) — an extra allowed dashboard origin, kept for older setups and
  `./setup.sh --dashboard-url`. Normally unneeded: the dashboard registers its own address
  (table `dashboard_origins`) when you sign in, and the functions allow those origins in CORS.
  `bank-consent-callback` sends the browser back to the origin that started the link.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected by Supabase into every function; nothing to set for those.
