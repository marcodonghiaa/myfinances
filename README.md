# finance-app

A personal finance pipeline: European PSD2 open banking (via [Enable Banking](https://enablebanking.com), currently connected to Revolut) → Supabase (Postgres) → categorization → dashboard.

## Status

Ingestion is live: transactions and daily net-worth snapshots sync automatically every morning via a local `launchd` job. Categorization and a dashboard are not built yet.

## How it works

1. **Auth (one-time / periodic)** — `start-auth.js` starts an Enable Banking PSD2 consent flow for Revolut, `exchange-code.js` exchanges the resulting authorization code for a session. Sessions expire (see `SESSION_VALID_UNTIL` in `.env`) and need to be redone periodically.
2. **Sync (daily, automated)** — `run-daily-sync.sh` runs `sync-transactions.js` and `sync-networth.js`, which pull data from the Enable Banking API and upsert it into Supabase.
3. **Scheduling** — a `launchd` LaunchAgent (`com.marco.financesync.plist`) runs `run-daily-sync.sh` every day at 9:00 AM local time and appends output to `sync-log-YYYY-MM-DD.txt`.

## Scripts

| Script | Purpose |
|---|---|
| `start-auth.js` | Kicks off the PSD2 consent flow, prints a URL to open in the browser to authorize with the bank. |
| `exchange-code.js` | Exchanges the auth code from the consent redirect for an Enable Banking session (accounts + session ID). |
| `sync-transactions.js` | Pulls new transactions per account since the last sync (`last-sync.json`) and upserts them into the Supabase `transactions` table. |
| `sync-networth.js` | Pulls current account balances and writes a snapshot row per account into `net_worth_snapshots`. |
| `session-check.js` | Shared helper — warns/errors if the Enable Banking session is expiring or expired. Imported by both sync scripts. |
| `get-transaction.js` | Debug/manual tool — dumps raw balances per account to stdout. Doesn't touch Supabase. |
| `test-bank.js` | Debug/manual tool — dumps raw balances per account to stdout. |
| `run-daily-sync.sh` | Entry point invoked by `launchd`; runs both sync scripts and logs to `sync-log-*.txt`. |

## Data

**Supabase tables:**
- `transactions` — one row per bank transaction (`entry_reference`, `account_uid`, `amount`, `currency`, `creditor_name`, `debtor_name`, `remittance_info`, `booking_date`, `category`, `raw` (full original JSON from the bank), `created_at`). `category` is currently unset — see Roadmap.
- `net_worth_snapshots` — one row per account per sync (`account_uid`, `currency`, `amount`, `eur_equivalent`, `snapshot_date`, `created_at`).

**Local state (gitignored, never committed):**
- `.env` — Enable Banking `APP_ID`, path to the PSD2 private key, Supabase URL + secret key, session expiry date.
- `*.pem` — Enable Banking PSD2 private key.
- `last-sync.json` — per-account watermark of the last synced date, so re-runs only pull new transactions.
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
SUPABASE_SECRET_KEY=<supabase service role key>
SESSION_VALID_UNTIL=<ISO date your current bank session expires>
```

Authorize with the bank (one-time, or whenever the session expires):

```bash
node start-auth.js   # open the printed URL, log in, approve consent
node exchange-code.js   # paste the code from the redirect into the script, run again
```

Run a sync manually:

```bash
bash run-daily-sync.sh
```

## Automated daily sync (launchd)

The LaunchAgent lives at `~/Library/LaunchAgents/com.marco.financesync.plist` and runs `run-daily-sync.sh` every day at 9:00 AM.

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

Note: `StartCalendarInterval` jobs only fire if the Mac is awake at 9 AM; if it's asleep, macOS generally runs it shortly after wake, but this isn't guaranteed.

## Security notes

- `.env`, `*.pem`, and `last-sync.json` are gitignored and must never be committed.
- `SUPABASE_SECRET_KEY` is a service-role key with full table access — it's only ever used server-side (local scripts), never in a browser context.
- The PSD2 private key (`*.pem`) authenticates this app to Enable Banking; treat it like a password.

## Roadmap

- [ ] AI categorization pass (Gemini) — read raw `transactions` rows, classify merchant/remittance text into a `category`, without touching the raw data.
- [ ] Dashboard (spend by category, net worth over time, budget vs. actual).
