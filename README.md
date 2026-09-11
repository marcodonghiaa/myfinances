# finance-app

An open-source, self-hosted net worth tracker: bank accounts, investment portfolio, and crypto holdings in one place, kept in sync automatically.

European PSD2 open banking (via [Enable Banking](https://enablebanking.com) — Revolut, Wise, Fineco and 2000+ other European banks) + manually-tracked brokerage/crypto holdings → your own Supabase (Postgres) project → deterministic rules + Gemini categorization → a [TanStack Start](https://tanstack.com/start) dashboard.

**Live demo (read-only, no login):** [myfinancesss.lovable.app/demo](https://myfinancesss.lovable.app/demo)

![Dashboard screenshot](https://raw.githubusercontent.com/marcodonghiaa/my-wealth-view/main/public/og-image.png)

This repo is the backend half — sync scripts, Supabase Edge Functions, and DB migrations. The frontend lives in a separate repo, [my-wealth-view](https://github.com/marcodonghiaa/my-wealth-view).

## Why this instead of X

- **[Firefly III](https://www.firefly-iii.org/) / [Actual Budget](https://actualbudget.org/)** — great for manual budgeting, but no automated bank sync or AI categorization out of the box.
- **[Ghostfolio](https://ghostfolio.dev/)** — great for portfolio tracking, but it's investments-only: no bank accounts, no transaction categorization.
- **This project** — automated PSD2 bank sync + AI categorization + subscriptions (auto-detected billing frequency, normalized to a true monthly cost) + portfolio + crypto, all in one net worth number, self-hosted on your own Supabase project. Trade-off: European (PSD2) banks only, and you run the sync yourself (cron/launchd, not a managed service).

## Status

Runs on autopilot via local scheduled jobs (`launchd` on macOS, or `cron`/systemd timers anywhere else): hourly bank sync, FX rates, AI categorization, and price refresh for portfolio/crypto, plus a "worth it?" push notification job for discretionary spending. The reference deployment is published at [myfinancesss.lovable.app](https://myfinancesss.lovable.app).

## How it works

Everything runs hourly through `run-daily-sync.sh` (name predates the schedule change — it loops over every linked user, in order):

1. **`sync-transactions.js`** — pulls new bank transactions since the last sync (Enable Banking API) and upserts them into `transactions`.
2. **`sync-networth.js`** — pulls current bank account balances into `net_worth_snapshots`.
3. **`fx-sync.js`** — pulls daily EUR exchange rates (Frankfurter/ECB) into `fx_rates`, used to convert every non-EUR balance/transaction to EUR across the dashboard.
4. **`categorize.js`** — categorizes each transaction. A deterministic rules engine (`category_rules` table, user-editable in the dashboard) runs first; anything unmatched falls through to Gemini.
5. **`classify-type.js`** — classifies each transaction as `Subscription` or `One-time`. Transfers are forced to `One-time` deterministically (no AI call); everything else goes through Gemini.
6. **`sync-portfolio-prices.js`** — fetches live prices for stock/ETF holdings (`portfolio_holdings`) from Yahoo Finance's free public quote endpoint (the same public-data source [Ghostfolio](https://ghostfolio.dev) uses) and writes `portfolio_snapshots`.
7. **`sync-crypto-coinbase.js`** — pulls live Coinbase balances via the Advanced Trade API (read-only key, JWT auth signed with Ed25519) and upserts them into `crypto_holdings`.
8. **`sync-crypto-prices.js`** — fetches live prices for all crypto holdings (Coinbase-synced and manually-tracked Ledger holdings alike) from CoinGecko's free API and writes `crypto_snapshots`.

Two more jobs run independently:

- **`notify-worth-it.js`** (every 30 min, `run-notify.sh`) — finds recent discretionary transactions (Shopping/Entertainment/Dine Out/Experiences, above a minimum amount, 3-24h old) with no `worth_it` answer yet, and sends a Web Push "worth it?" prompt (bundled into one digest notification if there are several), so you reflect on a purchase after the initial urge has faded but while it's still fresh.
- **`portfolio-reminder.sh`** (monthly) — fires a native OS notification on the 1st, since brokerage holdings (`portfolio_holdings`) are updated manually rather than live-synced.

Self-serve bank linking (connecting a new bank from the dashboard, no CLI needed) runs as three Supabase Edge Functions — see [`supabase/functions/README.md`](supabase/functions/README.md).

## Data model

Supabase project `diwezyrtlwdbrsgegkay` (org "Marcoo"). Every table is Row Level Security-scoped to `auth.uid() = user_id`.

**Tables**
| Table | Purpose |
|---|---|
| `accounts` | Bank accounts known to the pipeline (drives sync instead of hardcoded arrays), each with its own `consent_valid_until` since every linked bank's PSD2 consent expires independently. |
| `transactions` | One row per bank transaction — amount, currency, category, transaction_type, raw payload. Update access is trigger-restricted to just `category`/`transaction_type`. |
| `net_worth_snapshots` | Daily bank account balance snapshots. |
| `fx_rates` | Daily EUR conversion rates per currency. |
| `category_rules` | User-editable deterministic categorization rules, checked before Gemini. |
| `subscription_billing_overrides` | Manual override for a subscription's detected billing frequency (e.g. correcting a yearly prepayment that would otherwise look like a huge "monthly" charge). |
| `portfolio_holdings` / `portfolio_snapshots` | Stock/ETF holdings (manually maintained) and their daily priced value. |
| `crypto_holdings` / `crypto_snapshots` | Crypto holdings (Coinbase-synced or manually tracked) and their daily priced value. |

**Views** (all `security_invoker=true`, so RLS applies through them): `v_net_worth_eur`, `v_net_worth_daily` (unions bank/portfolio/crypto snapshot dates, each forward-filled independently), `v_transactions_eur`, `v_spend_by_category_monthly`, `v_income_vs_expenses_monthly`, `v_subscriptions` (auto-detects billing frequency from charge intervals), `v_portfolio_latest`, `v_crypto_latest`.

## Local state (gitignored, never committed)

- `.env` — Enable Banking app ID + PSD2 key path, Supabase URL + secret key, Gemini API key, Coinbase API credentials.
- `*.pem` — Enable Banking PSD2 private key.
- `last-sync.json` — per-account watermark so re-runs only pull new transactions.
- `sync-log-*.txt` — daily run logs.

## Setup

1. **Supabase project.** Create one at [supabase.com](https://supabase.com), then apply the schema:
   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push   # runs supabase/migrations/
   ```
2. **Enable Banking.** Sign up at [enablebanking.com](https://enablebanking.com), create an application (free "Restricted Production" tier works for whitelisting your own accounts — see the [ToS notes](supabase/functions/README.md) before going further), download the PSD2 private key.
3. **Edge Functions** (self-serve bank linking from the dashboard): deploy the three functions in `supabase/functions/` and set `ENABLE_BANKING_APP_ID` / `ENABLE_BANKING_PRIVATE_KEY` as Supabase Edge Function secrets — see [`supabase/functions/README.md`](supabase/functions/README.md).
4. **Local scripts:**
   ```bash
   npm install
   cp .env.example .env   # fill in Enable Banking, Supabase, Gemini, Coinbase (optional), VAPID keys
   ```

Link your first bank (one-time per bank, or whenever its consent expires — `session-check.js` warns as expiry approaches). Easiest via the dashboard's "Connect a bank" button (Accounts page) once Edge Functions are deployed; or from the CLI:

```bash
node start-auth.js "<Bank Name>" <COUNTRY>   # e.g. node start-auth.js "FinecoBank" IT
# open the printed URL, log in, approve consent — you'll be redirected to
# https://localhost:3000/callback?code=... (the page won't load, that's expected)
node exchange-code.js <code>   # prints the linked account(s) — add them to the `accounts` table
```

Run a full sync manually:

```bash
bash run-daily-sync.sh
```

## Automated sync (launchd, cron, or systemd)

macOS (`launchd`) is what the reference deployment uses — see `com.marco.financesync.plist` (hourly, runs `run-daily-sync.sh`) and `com.marco.worthitnotify.plist` (every 30 min, runs `run-notify.sh`) for the exact job definitions.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.marco.financesync.plist
launchctl print gui/$(id -u)/com.marco.financesync        # check it's loaded
launchctl kickstart -p gui/$(id -u)/com.marco.financesync # trigger manually
launchctl bootout gui/$(id -u)/com.marco.financesync.plist
```

On Linux, a `cron` entry (`0 * * * * cd /path/to/finance-app && bash run-daily-sync.sh`) or a systemd timer does the same job — there's nothing macOS-specific in the scripts themselves.

## Security notes

This is a public portfolio piece handling real personal financial data, so it's built security-first:

- `.env`, `*.pem`, and `last-sync.json` are gitignored and must never be committed.
- All Supabase tables are RLS-scoped to the authenticated user (`auth.uid() = user_id`) — no table is readable across users.
- The frontend never uses a service-role key — only the anon/publishable key, subject to RLS. Supabase's modern key system (`sb_publishable_...` / `sb_secret_...`) is used throughout; the legacy JWT key pair that could bypass RLS has been fully disabled.
- `transactions` is otherwise append-only from the pipeline's perspective — a Postgres trigger restricts user-initiated updates to just the `category` and `transaction_type` columns, with `EXECUTE` on the trigger function itself revoked from `anon`/`authenticated` so it can't be invoked directly via RPC.
- The Coinbase integration uses a read-only ("View") API key — it can never place trades or move funds.
- The PSD2 private key (`*.pem`) authenticates this app to Enable Banking; treat it like a password.

## License

TBD — coming soon.
