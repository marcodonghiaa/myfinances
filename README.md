# myfinances

A self-hosted net worth tracker. It syncs European bank accounts through PSD2 open banking, adds your brokerage and crypto holdings, categorizes everything, and stores it in your own Supabase project.

![Dashboard](https://raw.githubusercontent.com/marcodonghiaa/my-wealth-view/main/public/og-image.png)

This repo is the backend: sync scripts, Supabase Edge Functions and migrations. The dashboard is [my-wealth-view](https://github.com/marcodonghiaa/my-wealth-view).

**What you get:** automatic bank sync via [Enable Banking](https://enablebanking.com) (Revolut, Wise, Fineco and 2000+ other European banks), AI + rule-based categorization, subscription detection, portfolio and crypto pricing, and a "worth it?" push notification after discretionary purchases.

**Trade-offs:** European (PSD2) banks only, and you run the sync yourself (cron, launchd or Docker).

## How it works

A sync runs every 6 hours (banks typically cap unattended access at about 4 calls a day per account) and loops over every linked user:

1. `sync-transactions.js` pulls new transactions, with a 7-day overlap because banks post late.
2. `sync-networth.js` stores daily account balances.
3. `fx-sync.js` stores daily EUR rates (Frankfurter/ECB) and backfills history on first run.
4. `categorize.js` applies your `category_rules` first, then Gemini for the rest.
5. `classify-type.js` marks each transaction `Subscription` or `One-time`.
6. `classify-flow.js` marks `spend`, `income` or `transfer`, so exchanges and top-ups don't count as income.
7. `sync-portfolio-prices.js`, `sync-crypto-coinbase.js`, `sync-crypto-prices.js` price your holdings (Yahoo Finance, Coinbase, CoinGecko).

`notify-worth-it.js` runs every 30 minutes and sends a Web Push prompt for recent discretionary purchases. Portfolio and crypto scripts and notifications are single-user (`USER_ID`); bank sync is multi-user.

Bank linking from the dashboard runs as three Supabase Edge Functions, see [`supabase/functions/README.md`](supabase/functions/README.md).

## Setup

Guided: clone both repos side by side and run the wizard. It creates or links a Supabase project, applies the schema, deploys the functions and writes both `.env` files.

```bash
git clone https://github.com/marcodonghiaa/myfinances.git
git clone https://github.com/marcodonghiaa/my-wealth-view.git
cd myfinances
./setup.sh
docker compose up -d --build
```

The only manual step is Enable Banking's signup, which has no API. The wizard sends you there to create a free **Production** application and download a key.

Manual:

1. Create a Supabase project, then `supabase link --project-ref <ref>` and `supabase db push`.
2. In Enable Banking, create a Production application with redirect URL `https://<ref>.supabase.co/functions/v1/bank-consent-callback` (must match exactly). Activate it by linking one of your own accounts in their panel.
3. Deploy the functions and set `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY` and `FRONTEND_URL` as Edge Function secrets.
4. `npm install`, then `cp .env.example .env` and fill it in.

Link a bank from the dashboard's "Connect a bank" button on the Accounts page. Re-link it when its consent expires (`session-check.js` warns beforehand).

Run a sync by hand: `bash run-daily-sync.sh`

## Scheduling

Docker runs everything on its own schedule (`scheduler.js`). Without Docker, use cron or launchd:

```
0 */6 * * *    cd /path/to/myfinances && bash run-daily-sync.sh
*/30 * * * *   cd /path/to/myfinances && bash run-notify.sh
```

## Data model

Every table is Row Level Security scoped to `auth.uid() = user_id`. Main tables: `accounts`, `transactions` (primary key `(account_uid, entry_reference)`), `net_worth_snapshots`, `fx_rates`, `category_rules`, `subscription_billing_overrides`, `portfolio_holdings/snapshots`, `crypto_holdings/snapshots`. The dashboard reads `security_invoker` views such as `v_net_worth_daily`, `v_transactions_eur` and `v_subscriptions`.

## Security

- `.env`, `*.pem` and `last-sync.json` are gitignored. The Enable Banking key authenticates your app, so treat it like a password.
- The dashboard only uses the publishable key. The service-role key stays in the sync scripts and Edge Functions.
- A Postgres trigger blocks users from editing bank-sourced columns on `transactions`. Only category, type, flow, split and worth-it fields are writable.
- The bank-linking `state` is a single-use token, not a user id.
- The Coinbase integration uses a read-only key.

## License

[MIT](LICENSE)
