<div align="center">

# 💸 myfinances

**A self-hosted net worth tracker for European bank accounts, brokerage and crypto.**
Your data lives in your own Supabase project. No SaaS, no subscription.

[![Tests](https://github.com/marcodonghiaa/myfinances/actions/workflows/test.yml/badge.svg)](https://github.com/marcodonghiaa/myfinances/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node 22](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?logo=supabase&logoColor=white)
![PSD2](https://img.shields.io/badge/PSD2-2000%2B%20EU%20banks-blue)

![Dashboard](https://raw.githubusercontent.com/marcodonghiaa/my-wealth-view/main/docs/screenshots/net-worth.png)

</div>

> This repo is the **backend**: sync scripts, Supabase Edge Functions and migrations.
> The dashboard is [**my-wealth-view**](https://github.com/marcodonghiaa/my-wealth-view).

## ✨ Features

| | |
|---|---|
| 🏦 **Bank sync** | PSD2 open banking via [Enable Banking](https://enablebanking.com): Revolut, Wise, Fineco and 2000+ other European banks. Multi-user. |
| 🏷️ **Categorization** | Your own `category_rules` first, Gemini for the rest. Hand-set categories are never overwritten. The Gemini key is recommended but optional: without it, or when Gemini fails, your rules still run. |
| 🔁 **Subscription detection** | Every transaction is marked `Subscription` or `One-time`. |
| 🔀 **Flow detection** | `spend`, `income` or `transfer`, so exchanges and top-ups don't count as income. |
| 📈 **Portfolio and crypto** | Prices from Yahoo Finance, Coinbase (read-only key) and CoinGecko. |
| 💱 **FX** | Daily EUR rates from Frankfurter/ECB, history backfilled on first run. |
| 🔔 **"Worth it?" prompts** | Web Push after discretionary purchases. |

**Trade-offs:** European (PSD2) banks only, and you run the sync yourself (Docker, cron or launchd).

## 🧭 How it works

```mermaid
flowchart LR
    Bank[(Banks<br/>Enable Banking)] --> TX[sync-transactions]
    TX --> DB[(Supabase<br/>Postgres + RLS)]
    NW[sync-networth] --> DB
    FX[fx-sync] --> DB
    DB --> CAT[categorize<br/>rules, then Gemini]
    CAT --> TYPE[classify-type]
    TYPE --> FLOW[classify-flow]
    FLOW --> DB
    PRICES[portfolio + crypto prices<br/>Yahoo, Coinbase, CoinGecko] --> DB
    DB --> UI[my-wealth-view<br/>dashboard]
    DB --> PUSH[notify-worth-it<br/>Web Push]
```

A sync runs **every 6 hours** (banks typically cap unattended access at about 4 calls a day per account) and loops over every linked user:

1. `sync-transactions.js` pulls new transactions, with a 7-day overlap because banks post late.
2. `sync-networth.js` stores daily account balances.
3. `fx-sync.js` stores daily EUR rates.
4. `categorize.js` applies your rules first, then Gemini.
5. `classify-type.js` marks `Subscription` or `One-time`.
6. `classify-flow.js` marks `spend`, `income` or `transfer`, then pairs each card refund with its original charge (same account, merchant, amount and currency, within 90 days; the merchant of a refund is read from its "Refund from <merchant>" remittance) and marks both `refunded` so neither counts as spend or income.
7. `sync-portfolio-prices.js`, `sync-crypto-coinbase.js`, `sync-crypto-prices.js` price your holdings.

A newly linked bank doesn't wait for the next run: in Docker, every 5 minutes the scheduler syncs banks linked in the last hour that have never synced, then categorizes what arrived. With cron or launchd, run `bash run-daily-sync.sh` once after linking.

`notify-worth-it.js` runs every 30 minutes. Portfolio, crypto and notification scripts are single-user (`USER_ID`); bank sync is multi-user.

Bank linking from the dashboard runs as three Supabase Edge Functions, see [`supabase/functions/README.md`](supabase/functions/README.md).

**Built to keep running:** every outbound call has a 60 s timeout, each scheduled script a 10 minute limit, sync cursors are written atomically (and kept on a volume in Docker), and one user's failing rows can't block anyone else's classification.

## 🚀 Getting started

Want to look first? Try the [live demo](https://myfinancess-view.vercel.app/demo): fake data, no sign-up.

Your own copy takes about **30 minutes**, all in the browser: no computer has to stay on and nothing to install. Most of the time goes into Enable Banking's signup.

### 1. Create the accounts (about 15 minutes)

| Account | What it's for | Cost |
|---|---|---|
| [GitHub](https://github.com/signup) | runs the setup (Codespaces) and the sync (Actions) | free |
| [Supabase](https://supabase.com/dashboard) | your database and login | free tier is enough |
| [Enable Banking](https://enablebanking.com) | the PSD2 connection to your banks | free for your own accounts |
| [Vercel](https://vercel.com/signup) (sign in with GitHub) | puts the dashboard online over HTTPS | free Hobby plan |
| [Gemini API key](https://aistudio.google.com/apikey) | AI categories and subscription detection | free tier; optional, recommended |

In Enable Banking, sign up only; setup tells you when to create the app and gives the exact redirect URL.

### 2. Run the setup (about 10 minutes)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/marcodonghiaa/myfinances?quickstart=1)

This opens a terminal in your browser.

Free: 60 hours a month on a personal account, no card needed. First open takes 2-3 minutes. Codespaces has Node 22, the Supabase CLI and gh ready.

Run:

```bash
./setup.sh
```

Choose **1, GitHub Actions**. Setup forks this repo to your account, creates or links your Supabase project, applies the schema, deploys the functions, creates your login (the app has no sign-up screen), switches off public sign-ups, stores your keys as secrets of your fork and turns the sync on. When it asks for the `.pem`, drag it from your Downloads onto the file list on the left.

At the end it prints three values for the next step (also saved in `dashboard-values.txt`) and waits for you to open the dashboard and sign in once. Keep the Codespace open.

### 3. Put the dashboard online (about 5 minutes)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmarcodonghiaa%2Fmy-wealth-view&project-name=my-finances&repository-name=my-finances&env=VITE_SUPABASE_URL%2CVITE_SUPABASE_PUBLISHABLE_KEY%2CVITE_VAPID_PUBLIC_KEY&envDescription=Printed+by+setup.sh%2C+also+in+dashboard-values.txt&envLink=https%3A%2F%2Fgithub.com%2Fmarcodonghiaa%2Fmyfinances%23-getting-started)

Click **GitHub** first, then **Install Vercel** (All repositories is fine). Paste the three values setup printed and deploy, then open the address under **Domains** on the project page (not a deployment URL) and sign in. Your dashboard tells your database its own address on that first sign-in, so there is nothing to copy back: setup sees it, prints `Done! Open <your address>, sign in as <email>` and bank linking sends you back there. Closed the terminal first? Nothing is lost, the sign-in alone finishes it.

Then delete the Codespace, since it holds your keys: [github.com/codespaces](https://github.com/codespaces), the `...` menu, Delete. GitHub warns about unsaved changes: that's expected, delete anyway. Everything you set up stays in Supabase, GitHub and Vercel.

### 4. Link a bank and add your investments

Sign in on your dashboard. On **Accounts**, use **Connect a bank**: balances show at once, and the transactions arrive with the next sync (every 6 hours; to get them now, open your fork's **Actions** tab, **Sync**, **Run workflow**). On **Portfolio**, **Add an investment** finds yours by name, ticker or ISIN; on **Crypto**, **Add a coin**. A checklist on the dashboard shows what's left.

Bank access lasts 180 days. Two weeks before it ends the Accounts page shows a **Renew access** banner, and you get a push notification the day the banner appears, then 7 days, 1 day and on the day it expires.

Run `./setup.sh` again any time: it keeps what's in `.env`, asks only for what's missing, and applies new migrations and functions. Forgot your password? `./setup.sh --reset-password`.

<details>
<summary><b>On your own computer or server instead (Docker)</b></summary>

Needs [Docker](https://www.docker.com/products/docker-desktop), the [Supabase CLI](https://supabase.com/docs/guides/cli) and [Node 22](https://nodejs.org). The sync runs only while that machine is on.

```bash
git clone https://github.com/marcodonghiaa/myfinances.git
git clone https://github.com/marcodonghiaa/my-wealth-view.git
cd myfinances
./setup.sh          # choose 2, Docker
docker compose up -d --build
```

Open http://localhost:3000. With Docker, a newly linked bank's last 90 days of transactions arrive within about 5 minutes. Check your configuration any time with `node env-check.js`.

</details>

<details>
<summary><b>Manual setup</b></summary>

1. Create a Supabase project, then `supabase link --project-ref <ref>` and `supabase db push`.
2. In Enable Banking, create a Production application with redirect URL `https://<ref>.supabase.co/functions/v1/bank-consent-callback` (must match exactly). Activate it by linking one of your own accounts in their panel.
3. Deploy the functions and set `ENABLE_BANKING_APP_ID` and `ENABLE_BANKING_PRIVATE_KEY` as Edge Function secrets. (`FRONTEND_URL` is optional: the dashboard registers its own address when you sign in.)
4. In the dashboard, **Authentication -> Users -> Add user** (tick auto-confirm) to create your login, and put its id in `.env` as `USER_ID`.
5. **Authentication -> Sign In / Providers -> User Signups**: turn off *Allow new users to sign up*. Supabase leaves it on, which lets anyone who finds your project URL create an account.
6. `npm install`, then `cp .env.example .env` and fill it in.

</details>

## 🛠️ Everyday commands

| Task | Command |
|---|---|
| Run a full sync by hand | `bash run-daily-sync.sh` |
| Send "worth it?" prompts now | `bash run-notify.sh` |
| Re-apply changed category rules | `node categorize.js --reapply-rules` |
| Check your `.env` | `node env-check.js` |
| Run the tests | `npm test` |

`--reapply-rules` recategorizes rows the AI or an earlier rule set. Categories you set by hand are never touched (tracked in `transactions.category_source`; categories that predate the column count as hand-set).

## ⏰ Scheduling

**On GitHub, no computer needed:** in your fork, add the secrets `APP_ID`, `PRIVATE_KEY` (the whole `.pem`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `USER_ID` and, if you use them, `GEMINI_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `COINBASE_API_KEY_NAME`, `COINBASE_API_PRIVATE_KEY` (Settings -> Secrets and variables -> Actions). Then add the variable `SYNC_ON_GITHUB` = `true` and enable Actions on the fork. [`.github/workflows/sync.yml`](.github/workflows/sync.yml) then syncs every 6 hours, sends "worth it?" prompts hourly and the bank-access reminder daily; run any of them by hand from the Actions tab. Your fork is public, so its list of runs is public too: the sync logs only counts, never names or amounts, and setup keeps logs for 1 day. GitHub can start scheduled runs 10-30 minutes late.


Docker runs everything on its own schedule (`scheduler.js`). Without Docker, use cron or launchd:

```cron
0 */6 * * *    cd /path/to/myfinances && bash run-daily-sync.sh
*/30 * * * *   cd /path/to/myfinances && bash run-notify.sh
0 9 * * *      cd /path/to/myfinances && node consent-notice.js
```

## 🗄️ Data model

Every table is Row Level Security scoped to `auth.uid() = user_id`.

| Area | Tables |
|---|---|
| Banking | `accounts`, `transactions` (primary key `(account_uid, entry_reference)`), `net_worth_snapshots`, `fx_rates` |
| Rules | `category_rules`, `subscription_billing_overrides` |
| Investments | `portfolio_holdings` / `portfolio_snapshots`, `crypto_holdings` / `crypto_snapshots` |

The dashboard reads `security_invoker` views such as `v_net_worth_daily`, `v_transactions_eur` and `v_subscriptions`. Schema changes live in [`supabase/migrations`](supabase/migrations).

## 🔒 Security

- `.env`, `*.pem` and `last-sync.json*` are gitignored. The Enable Banking key authenticates your app, so treat it like a password.
- The dashboard only uses the publishable key. The service-role key stays in the sync scripts and Edge Functions.
- A Postgres trigger blocks users from editing bank-sourced columns on `transactions`. Only category, type, flow, split and worth-it fields are writable.
- The bank-linking `state` is a single-use token, not a user id, and error text is never reflected into the redirect.
- Bank text is sent to the LLM as untrusted data, in per-user batches.
- The Coinbase integration uses a read-only key.

## 🤝 Contributing

Tests run on every push and pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

[MIT](LICENSE)
