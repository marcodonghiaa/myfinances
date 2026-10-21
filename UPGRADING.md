# Upgrading

Pulling new code does not update your database. Migrations are not applied automatically, and the sync scripts only change once you redeploy them. Find your version below and do what each change asks.

For every release: `git pull`, then `supabase db push` for new migrations, then rebuild or restart the sync jobs (`docker compose up -d --build`, or nothing for cron or launchd, which run the new files on their next run).

## Release notes, newest first

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
- `merchant_aliases` (`20261027000000`) and `net_worth_daily_bonds` (`20261028000000`) were added to this repo. If you already created them by hand or from the frontend repo, `supabase db push` may fail with "already exists". Then mark them applied instead: `supabase migration repair --status applied 20261027000000 20261028000000`, and push again.

## Known limits
- Portfolio, crypto and notification scripts are single-user (`USER_ID`). Bank sync is multi-user.
- Importing the same Splitwise group and date range again deletes and reinserts those rows, so edits you made to them are lost.
- Nothing trims old data. Daily net worth snapshots, FX rates and transactions are kept forever. The dashboard reads at most 1000 rows per query, which daily net worth would reach after about 2.6 years of daily snapshots.
