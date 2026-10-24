# Upgrading

Pulling new code does not update your database. Migrations are not applied automatically, and the sync scripts only change once you redeploy them. Find your version below and do what each change asks.

For every release: `git pull`, then `supabase db push` for new migrations, then rebuild or restart the sync jobs (`docker compose up -d --build`, or nothing for cron or launchd, which run the new files on their next run).

## Release notes, newest first

### Small setup fixes
- **No migration. Nothing to do.**
- `run-daily-sync.sh` and `run-notify.sh` use the `node` on your PATH, falling back to Homebrew's `/opt/homebrew/bin/node` (cron and launchd start with a bare PATH). Set `NODE=/path/to/node` to pick one. Before, the Homebrew path was hard-coded, so Linux and Intel Macs failed.
- `SESSION_VALID_UNTIL` is gone from `.env.example`: no script read it (bank access is always requested for 180 days). An old line in your `.env` is harmless.
- `setup.sh` no longer prints the new database password: nothing needs it later, and it stayed in the terminal history.

### setup.sh can be run again, and resets your password
- **No migration.**
- Re-running `./setup.sh` used to overwrite both `.env` files and ask for everything again (Coinbase keys and hand edits were lost). Now it reads `.env` first, keeps the project, login, Enable Banking key, VAPID keys and Gemini key it finds, and merges what it writes, so keys it doesn't manage stay. It still pushes new migrations and redeploys the functions, so a re-run is also an easy upgrade.
- `./setup.sh --reset-password` sets a new password for your login (the app has no "forgot password" screen).
- **Docker installs:** `.env` now gets `VITE_VAPID_PUBLIC_KEY`, which `docker-compose.yml` passes to the dashboard build. Before, setup never wrote it, so push notifications could not subscribe on a Docker install. Add it by hand (same value as `VAPID_PUBLIC_KEY`) or re-run `./setup.sh`, then `docker compose up -d --build`.
- `.env` also gets `FRONTEND_URL`, offered as the default on the next run.

### Reminder before a bank's access expires
- **No migration. Redeploy the sync jobs.** Cron and launchd installs: add a daily `node consent-notice.js` (see Scheduling in the README).
- Bank access (PSD2 consent) lasts 180 days, then the bank silently stops syncing. `consent-notice.js` now sends a push notification 7 days, 1 day and on the day a bank's access ends; the dashboard's Accounts page shows a banner from 14 days before (frontend change).
- The Docker scheduler runs it at start and then daily, so restarting the container on a reminder day sends that day's reminder again.
- `notify-worth-it.js` now shares its push code with it (`push.js`); behavior is unchanged.

### .env is checked before the sync starts
- **No migration. Redeploy the sync jobs.**
- The Docker scheduler and `run-daily-sync.sh` now run `env-check.js` first. A missing or wrong value (no secret key, the publishable key pasted as the secret one, an unreadable `.pem`, no `USER_ID`) stops the sync with one line naming the variable, instead of every script failing on its own. Optional features that are off (Gemini, push notifications, a half-set Coinbase key) are listed as warnings.
- Check by hand any time: `node env-check.js`.
- `sync-crypto-coinbase.js` no longer fails when Coinbase isn't configured; it skips.

### Setup switches off public sign-ups by itself
- **Nothing to do on an existing install** if you already switched sign-ups off (see the next section).
- `setup.sh` now turns them off with `supabase config push`, using a temporary config that declares only `enable_signup = false`, so no other project setting is changed. It checks the result and falls back to the dashboard instructions if the push fails.

### Your rules no longer depend on Gemini
- **No migration. Redeploy the sync jobs.**
- Before, `categorize.js` and `classify-type.js` stopped before doing anything if `GEMINI_API_KEY` was missing, so your category rules didn't run either. A Gemini error (quota, outage) also stopped the run.
- Now, without a key, `categorize.js` applies your rules to every uncategorized transaction and `classify-type.js` marks transfers One-time. If Gemini fails mid-run, the same fallback runs and the script still exits with an error so it shows in your logs. `categorize-splitwise.js` skips with a warning.
- The key stays recommended: without it, transactions no rule matches stay uncategorized and subscriptions are not detected.

### A newly linked bank shows its transactions within minutes
- **No migration. Redeploy the sync jobs** (`docker compose up -d --build`).
- Before, linking a bank stored its balance right away but its transactions only at the next 6-hour sync.
- Now the Docker scheduler checks every 5 minutes for banks linked in the last hour that have never synced, pulls their last 90 days and categorizes them. Other accounts are not called, so the banks' daily call limits are unaffected. If that first sync keeps failing, it stops retrying after an hour and the regular sync takes over.
- Cron and launchd installs are unchanged: run `bash run-daily-sync.sh` once after linking, or wait for the next run.

### Switch off public sign-ups (existing installs read this)
- **No migration. One step in your Supabase dashboard.**
- Supabase leaves sign-ups open on every new project. The app has no sign-up screen, but anyone who finds your project URL and its public key can still create an account through the Auth API. They could then call the bank functions and use up your Enable Banking quota.
- **Do this:** Authentication -> Sign In / Providers -> User Signups -> turn off *Allow new users to sign up* -> Save. Your own login keeps working.
- `setup.sh` now creates your login and `USER_ID` for you and walks you through this step. `start-bank-consent` and `list-banks` also validate their input, and `start-bank-consent` refuses a sixth open consent request per user (redeploy with `supabase functions deploy`).

### Re-importing Splitwise keeps your edits
- **Migration:** `20261031000000_splitwise_import_keeps_edits`. Apply with `supabase db push`.
- **Why:** importing the same group and date range again deleted every row in the range and reinserted it from the file, so a description or category you had edited was lost.
- **Effect:** rows already stored (matched by fingerprint) keep their edited description and category; an empty category is filled from the file. New rows are inserted and rows the file no longer has are deleted. An expense you change in Splitwise itself gets a new fingerprint, so edits on it are still lost.
- **Roll back:** the matching file in `supabase/rollbacks/`.

### EUR views keep every row, net worth no longer dips
- **Migrations:** `20261029000000_fx_eur_fallback`, `20261030000000_net_worth_carry_forward`. Apply with `supabase db push`.
- **Why:** an EUR row dated before the first stored FX rate used to vanish from every euro view. A holding with no price on the latest day made that whole day's net worth dip.
- **Effect:** EUR rows always stay. A non-EUR currency with no rate now shows a NULL euro amount instead of disappearing. A holding keeps its last known value until it is priced again; a sold holding drops out the day after its last snapshot.
- **Roll back:** the matching files in `supabase/rollbacks/`.

### Card refunds pair with their purchase more often
- **No migration. Redeploy the sync jobs.**
- A refund whose `creditor_name` is the account holder, or whose charge has no `creditor_name`, now pairs by the merchant in the remittance text. Existing unpaired refunds pair on the next daily classify run.

### Coinbase holdings that reach zero are zeroed
- **No migration. Redeploy the sync jobs.**
- Before, an account that dropped to exactly 0 was skipped, so its old amount stayed in `crypto_holdings` and kept being priced. Now its amount is set to 0 on the next Coinbase sync. A missing or malformed balance is still skipped, never read as zero.

### Schema files cleanup (existing installs read this)
- Rollback files moved from `supabase/migrations/` to `supabase/rollbacks/`, so `supabase db push` no longer trips over them.
- `merchant_aliases` (`20261027000000`) and `net_worth_daily_bonds` (`20261028000000`) were added to this repo. If you already created them by hand or from the frontend repo, `supabase db push` fails with `Found local migration files to be inserted before the last migration on remote database` and suggests `--include-all`. Do not use `--include-all`: it would re-run the `create table` and fail with "already exists". Mark them applied instead: `supabase migration repair --status applied 20261027000000 20261028000000`, then `supabase db push` again. (Tested on a local Supabase: after the repair, push reports the database is up to date.)

## Known limits
- Portfolio, crypto and notification scripts are single-user (`USER_ID`). Bank sync is multi-user.
- Nothing trims old data. Daily net worth snapshots, FX rates and transactions are kept forever. The dashboard reads at most 1000 rows per query, which daily net worth would reach after about 2.6 years of daily snapshots.
