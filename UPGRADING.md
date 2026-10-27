# Upgrading

Pulling new code does not update your database. Migrations are not applied automatically, and the sync scripts only change once you redeploy them. Find your version below and do what each change asks.

For every release: `git pull`, then `supabase db push` for new migrations, then rebuild or restart the sync jobs (`docker compose up -d --build`, or nothing for cron or launchd, which run the new files on their next run).

## Release notes, newest first

### Accounts show the bank's name and logo
- **Migration:** `20261105000000_account_bank`. Apply it with `supabase db push` BEFORE redeploying `bank-consent-callback` (`supabase functions deploy bank-consent-callback`), then update the dashboard. A callback deployed before the migration fails every bank link, because it writes columns that don't exist yet.
- `accounts` gains `bank_name`, `bank_country` and `bank_logo`, and `v_bank_accounts_latest` exposes `bank_name`, `bank_logo` and `bank_country`. Before, an account was named after the holder name Enable Banking returns.
- Banks you already connected keep their current name until their next Renew access, which fills in the bank.
- **Roll back:** revert the code first, then `supabase/rollbacks/20261105000000_account_bank.down.sql`.

### A bank that closes access early shows Renew
- **No migration. Nothing to do** beyond redeploying the sync.
- When a bank ends its consent before the date it gave (Enable Banking answers `EXPIRED_SESSION`), the balance sync sets that account's consent end to today, so the Renew banner shows at once and the daily consent push fires. A later date is never set, and other 401/403 errors (a bad key, an inactive app) change nothing.
- The sync log ends with `Marked N account(s) for renewal (bank closed access early)` when this happens.

### Bank access push also when the banner appears
- **No migration. No action.** The push now also fires 14 days before access ends, the day the Accounts banner appears.

### Banks keep syncing after Renew access
- **Migration:** `20261104000000_account_eb_uid`. Apply it with `supabase db push`, then redeploy `bank-consent-callback` (`supabase functions deploy bank-consent-callback`). Until the migration is applied the sync logs a warning and keeps using the old ids, so a renewed bank still stops when its old consent ends.
- Enable Banking gives an account a new id when you renew access. The old id stops working when the old consent ends, so a renewed bank silently stopped updating. The new id is now stored in `accounts.eb_account_uid` and the sync uses it; history stays on the same account.
- The balance sync fills in a missing bank id (`identification_hash`) once per older account, so a later renewal finds it instead of adding a duplicate account.
- The sync log ends with `EB refused N account(s)` when the bank rejects an account id.
- **Roll back:** revert the code first, then `supabase/rollbacks/20261104000000_account_eb_uid.down.sql`.

### Set up from the browser with GitHub Codespaces
- **No migration. Nothing to do on an existing install.**
- `.devcontainer/devcontainer.json`: Node 22, GitHub CLI and Supabase CLI, ready in a Codespace. README has an "Open in GitHub Codespaces" button.
- In a Codespace, `setup.sh` signs `gh` in as you (the Codespace's own token can't write secrets). Run from a repo you don't own, it offers to fork it to your account and sets the sync up on the fork. It also says how to upload the `.pem`, and reminds you to delete the Codespace afterwards since it holds your keys.

### setup.sh can turn on the GitHub Actions sync
- **No migration.**
- `setup.sh` now asks where the sync runs. With GitHub Actions it needs the GitHub CLI and your fork (it checks you are an admin of the repo), writes every secret the workflow reads, sets `SYNC_ON_GITHUB=true` and enables Actions. Docker is then not needed: the functions deploy with `--use-api`.
- The choice is saved as `SYNC_ON` in `.env` and offered as the default on the next run. The frontend `.env` is skipped when there is no local frontend checkout (Vercel keeps its own settings).
- Fixed: a re-run with an existing login crashed on its last line (`LOGIN_EMAIL: unbound variable`).

### Optional: run the sync on GitHub Actions
- **No migration** (needs `20261102000000_sync_cursors` from the previous release). Nothing changes for Docker, cron or launchd installs.
- New workflow `.github/workflows/sync.yml`, off until the repository variable `SYNC_ON_GITHUB` is `true`. See Scheduling in the README for the secrets it needs.
- `node scheduler.js --once <sync|notify|consent>` runs one job and exits, non-zero if a step failed; the workflow uses it. The job lists moved to `jobs.js`, shared with the Docker scheduler.

### Sync progress is stored in the database
- **Migration:** `20261102000000_sync_cursors`. Apply it, then redeploy the sync jobs.
- Where each account's transaction sync got to used to live only in `last-sync.json` next to the scripts. It now lives in the `sync_cursors` table too, so the sync can run on a machine that keeps no files between runs (the GitHub Actions option coming next).
- Nothing to move by hand: the next sync reads your existing `last-sync.json` and copies it into the table. The file is still written as a local copy, and the sync keeps working from it if the migration isn't applied yet (with a warning in the log).

### Add investments and crypto from the dashboard
- **Migration:** `20261101000000_holdings_self_service`. Apply with `supabase db push`. **Deploy the new function:** `supabase functions deploy add-holding`.
- Before, `portfolio_holdings` and `crypto_holdings` could only be filled in SQL. The migration lets a signed-in user add, edit and delete their own rows (prices stay read-only), allows `Manual` as a crypto source, and removes the `Trade Republic` default broker.
- The new `add-holding` Edge Function searches Yahoo Finance and CoinGecko and saves a holding with today's price. The dashboard screen that uses it ships in my-wealth-view.
- A holding added by name or ticker has no ISIN; its Yahoo symbol is stored in the `isin` column instead.
- Holdings quoted in pence (`GBp`, London listings) are now priced in GBP. Before, they failed every day with "No fx_rates row for currency GBp".
- **Roll back:** `supabase/rollbacks/20261101000000_holdings_self_service.down.sql` (fails while a `Manual` crypto row exists).

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
