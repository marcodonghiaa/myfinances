# finance-app

The data pipeline behind [My Wealth View](https://myfinancesss.lovable.app) — a personal net worth tracker spanning bank accounts, an investment portfolio, and crypto holdings.

European PSD2 open banking (via [Enable Banking](https://enablebanking.com), currently connected to Revolut) + manually-tracked brokerage/crypto holdings → Supabase (Postgres) → deterministic rules + Gemini categorization → [Lovable](https://lovable.dev) dashboard.

This repo is the backend half. The frontend lives in a separate repo, [my-wealth-view](https://github.com/marcodonghiaa/my-wealth-view).

## Status

Live and running daily via a local `launchd` job: bank sync, FX rates, AI categorization, stock portfolio pricing, and crypto pricing (including a live Coinbase balance sync). The dashboard is published at [myfinancesss.lovable.app](https://myfinancesss.lovable.app) (Supabase Auth login required — no public data view).

## How it works

Everything runs daily through `run-daily-sync.sh`, in order:

1. **`sync-transactions.js`** — pulls new bank transactions since the last sync (Enable Banking API) and upserts them into `transactions`.
2. **`sync-networth.js`** — pulls current bank account balances into `net_worth_snapshots`.
3. **`fx-sync.js`** — pulls daily EUR exchange rates (Frankfurter/ECB) into `fx_rates`, used to convert every non-EUR balance/transaction to EUR across the dashboard.
4. **`categorize.js`** — categorizes each transaction. A deterministic rules engine (`category_rules` table, user-editable in the dashboard) runs first; anything unmatched falls through to Gemini.
5. **`classify-type.js`** — classifies each transaction as `Subscription` or `One-time`. Transfers are forced to `One-time` deterministically (no AI call); everything else goes through Gemini.
6. **`sync-portfolio-prices.js`** — fetches live prices for stock/ETF holdings (`portfolio_holdings`) from Yahoo Finance's free public quote endpoint (the same public-data source [Ghostfolio](https://ghostfolio.dev) uses) and writes `portfolio_snapshots`.
7. **`sync-crypto-coinbase.js`** — pulls live Coinbase balances via the Advanced Trade API (read-only key, JWT auth signed with Ed25519) and upserts them into `crypto_holdings`.
8. **`sync-crypto-prices.js`** — fetches live prices for all crypto holdings (Coinbase-synced and manually-tracked Ledger holdings alike) from CoinGecko's free API and writes `crypto_snapshots`.

A separate monthly job (`portfolio-reminder.sh`, via `com.marco.portfolioreminder`) fires a native macOS notification on the 1st of the month, since brokerage holdings (`portfolio_holdings`) are updated manually rather than live-synced.

## Data model

Supabase project `diwezyrtlwdbrsgegkay` (org "Marcoo"). Every table is Row Level Security-scoped to `auth.uid() = user_id`.

**Tables**
| Table | Purpose |
|---|---|
| `accounts` | Bank accounts known to the pipeline (drives sync instead of hardcoded arrays). |
| `transactions` | One row per bank transaction — amount, currency, category, transaction_type, raw payload. Update access is trigger-restricted to just `category`/`transaction_type`. |
| `net_worth_snapshots` | Daily bank account balance snapshots. |
| `fx_rates` | Daily EUR conversion rates per currency. |
| `category_rules` | User-editable deterministic categorization rules, checked before Gemini. |
| `subscription_billing_overrides` | Manual override for a subscription's detected billing frequency (e.g. correcting a yearly prepayment that would otherwise look like a huge "monthly" charge). |
| `portfolio_holdings` / `portfolio_snapshots` | Stock/ETF holdings (manually maintained) and their daily priced value. |
| `crypto_holdings` / `crypto_snapshots` | Crypto holdings (Coinbase-synced or manually tracked) and their daily priced value. |

**Views** (all `security_invoker=true`, so RLS applies through them): `v_net_worth_eur`, `v_net_worth_daily` (unions bank/portfolio/crypto snapshot dates, each forward-filled independently), `v_transactions_eur`, `v_spend_by_category_monthly`, `v_income_vs_expenses_monthly`, `v_subscriptions` (auto-detects billing frequency from charge intervals), `v_portfolio_latest`, `v_crypto_latest`.

## Local state (gitignored, never committed)

- `.env` — Enable Banking app ID + PSD2 key path, Supabase URL + secret key, Gemini API key, Coinbase API credentials, session expiry date.
- `*.pem` — Enable Banking PSD2 private key.
- `last-sync.json` — per-account watermark so re-runs only pull new transactions.
- `sync-log-*.txt` — daily run logs.

## Setup

```bash
npm install
```

Create a `.env` with:

```
APP_ID=<enable banking application id>
PRIVATE_KEY_FILE=<path to your PSD2 private key .pem>
SUPABASE_URL=<supabase project url>
SUPABASE_SECRET_KEY=<supabase secret key, sb_secret_...>
SESSION_VALID_UNTIL=<ISO date your current bank session expires>
GEMINI_API_KEY=<gemini api key>
USER_ID=<your supabase auth user id>
COINBASE_API_KEY_NAME=<coinbase api key id>
COINBASE_API_PRIVATE_KEY=<coinbase ed25519 private key, base64>
```

Authorize with the bank (one-time, or whenever the session expires):

```bash
node start-auth.js   # open the printed URL, log in, approve consent
node exchange-code.js   # paste the code from the redirect into the script, run again
```

Run a full sync manually:

```bash
bash run-daily-sync.sh
```

## Automated daily sync (launchd)

```bash
# load/enable the job
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.marco.financesync.plist

# check it's loaded
launchctl print gui/$(id -u)/com.marco.financesync

# trigger it manually (useful for testing)
launchctl kickstart -p gui/$(id -u)/com.marco.financesync

# unload it
launchctl bootout gui/$(id -u)/com.marco.financesync.plist
```

`StartCalendarInterval` jobs only fire if the Mac is awake at the scheduled time; if it's asleep, macOS generally runs it shortly after wake, but this isn't guaranteed.

## Security notes

This is a public portfolio piece handling real personal financial data, so it's built security-first:

- `.env`, `*.pem`, and `last-sync.json` are gitignored and must never be committed.
- All Supabase tables are RLS-scoped to the authenticated user (`auth.uid() = user_id`) — no table is readable across users, even though there's currently only one.
- The frontend never uses a service-role key — only the anon/publishable key, subject to RLS. Supabase's modern key system (`sb_publishable_...` / `sb_secret_...`) is used throughout; the legacy JWT key pair that could bypass RLS has been fully disabled.
- `transactions` is otherwise append-only from the pipeline's perspective — a Postgres trigger restricts user-initiated updates to just the `category` and `transaction_type` columns, with `EXECUTE` on the trigger function itself revoked from `anon`/`authenticated` so it can't be invoked directly via RPC.
- The Coinbase integration uses a read-only ("View") API key — it can never place trades or move funds.
- The PSD2 private key (`*.pem`) authenticates this app to Enable Banking; treat it like a password.

## Roadmap

See the pinned project memory / conversation history for the live list — current focus is dashboard polish (drawing on [Actual Budget](https://github.com/actualbudget/actual) and a personal net-worth spreadsheet as design references) rather than new data sources.
