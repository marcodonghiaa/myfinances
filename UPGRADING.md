# Upgrading

Pulling new code does not update your database. Migrations are not applied automatically, and the sync scripts only change once you redeploy them. Find your version below and do what each change asks.

For every release: `git pull`, then `supabase db push --linked` for new migrations (keep `--linked`: since Supabase CLI v3 a plain `db push` targets a local database, not your project), then rebuild or restart the sync jobs (`docker compose up -d --build`, or nothing for cron or launchd, which run the new files on their next run).

To roll a change back: run its file from `supabase/rollbacks/` in the Supabase SQL editor (or with `psql`), then `supabase migration repair --status reverted <version> --linked` (the version is the number at the start of the file name). Without the repair, a later `supabase db push --linked` still counts the migration as applied and does not bring it back.

## Release notes, newest first

## Unreleased

### Recurring calendar and regular income
- **Migration:** `20261210000000_income_kind_rules`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard (the dashboard reads and writes the new column). No Edge Function changes.
- Subscriptions has a Calendar view: the month's expected charges from your recurring streams, ticked once paid, and the income you get regularly.
- Income splits Regular and One-off. A sender that paid you in at least 3 of the last 6 months counts as regular, whatever the amount. "Mark as regular" or "Mark as one-off" on a row saves a rule (`category_rules.set_income_kind`) that overrides the guess for that name.
- **Roll back:** revert the dashboard first (it reads the new column on every rules load), then run `supabase/rollbacks/20261210000000_income_kind_rules.down.sql` and `supabase migration repair --status reverted 20261210000000 --linked` (so a later `db push` re-applies it). The down file deletes rules that only marked income; rules that also set a category, type or flow keep those and lose only the mark.

### Income shows who paid you
- **Migration:** `20261209000000_transactions_payer_name`. Apply it with `supabase db push --linked` after `20261208120000_transaction_notes_tags` and BEFORE redeploying the dashboard: the new dashboard asks `v_transactions_eur` for `payer_name`, and an older database answers with an error, so the Income and Cash flow pages would not load.
- `v_transactions_eur` gets one new column at the end, `payer_name`: the name you gave the row, or else who paid you (the bank's debtor name). On an incoming payment the old "creditor" name is often your own name or empty, so Income and Cash flow now name the payer instead. Nothing else in the view changes and no rows are touched.
- **Roll back:** redeploy the previous dashboard, then `supabase migration repair --status reverted 20261209000000 --linked`. The column can stay: an older dashboard never reads it (see `supabase/rollbacks/20261209000000_transactions_payer_name.down.sql`).

### Notes and tags on transactions
- **Migration:** `20261208120000_transaction_notes_tags`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: the new dashboard reads the new columns, and its Transactions page can't load without them. No Edge Function or sync change.
- Each transaction can have a note (free text, up to 2000 characters) and tags (up to 20, each up to 40 characters, created as you type). The Transactions page filters by tag and its search also matches notes. Both are in the data export.
- The bank sync never writes them, so a sync re-run keeps them. Only your own rows can be changed (same rule as categories).
- **Needs a UTF8 database** (every Supabase project is). On a plain Postgres created with another encoding (initdb's default can be SQL_ASCII), saving tags fails with `Unicode normalization can only be performed if server encoding is UTF8`. Check with `show server_encoding;`.
- **Roll back:** revert the dashboard first (this release's dashboard calls `my_transaction_tags`, which the rollback drops), then `supabase/rollbacks/20261208120000_transaction_notes_tags.down.sql`. It drops tag suggestions and the limits; the note and tags columns stay, with what you wrote, and an older dashboard ignores them. Pushing the migration again later works: it tidies anything written in between (blank notes, extra spaces, repeated tags).

## v0.2.0 (11 Nov 2026)

Budgets, two-step sign-in, rules that match whole words, debts, transfers that stop counting as spending, safer imports and refunds.

**Upgrade with the installer:** run `npx create-alopex@0.2.0` in the same folder you installed into. It keeps `backend/.env`, applies the new migrations, deploys the Edge Functions and redeploys the dashboard, in that order.

**Upgrade by hand**, in this order:
1. Backend: `git pull`, then `supabase db push --linked` (13 migrations, 20261124 to 20261207).
2. `supabase functions deploy` (new function `reapply-rules`; `post-sync`, `sync-bank` and others changed).
3. Dashboard: `git pull` and redeploy. One exception: deploy the dashboard before or together with step 1 if you import statements, see "Manual rows and imports get input limits".
4. Docker or launchd sync only: rebuild or restart it.

If you use your own PostgREST pre-request hook, read "Two-step sign-in" before step 1. Each change below says what it needs and how to roll it back.

### Deleting a rule can re-sort the transactions it filed
- No migration. Run `supabase functions deploy reapply-rules` BEFORE redeploying the dashboard (an older function ignores the new request and would preview your current rules instead).
- After you delete a rule on the Rules page, it offers to re-sort the transactions that rule had filed and no other rule matches (for example "Barclays" filed as Dine Out by an old "bar" rule). They go back to uncategorized and the next sync sorts them again. Categories you set by hand and Transfer rows never change. If the rule also set a transaction type, that type stays on those rows.

### Manual rows and imports get input limits
- **Migration:** `20261207000000_manual_transaction_checks`. Redeploy the **dashboard first** (or at the same time), then apply it with `supabase db push --linked`. An older dashboard sends descriptions longer than 500 characters, which the new database refuses: an import would stop at that row on every retry.
- Rows added by hand or by a statement import (`add_manual_transaction`) now have limits: amounts up to a trillion, a 3-letter currency, descriptions up to 500 characters, categories up to 100, a debit or credit direction, and up to 60 characters for the name of a new manual account (accounts named before keep working).
- Rows sent in parallel by an import no longer create the same manual account twice.
- Only the function changes; existing rows are untouched.
- **Roll back:** `supabase/rollbacks/20261207000000_manual_transaction_checks.down.sql` (restores the previous function).
### Rules match whole words and apply to past transactions from the dashboard
- **Migration:** `20261206000000_rule_match_mode`. You apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions and the Docker/launchd sync (they read the new column), then `supabase functions deploy` (new function `reapply-rules`) and redeploy the dashboard.
- A rule now says how its text must appear (`category_rules.match_mode`): `word` (on its own, so "bar" no longer matches "Barclays"), `exact` (the whole field) or `contains` (anywhere). Rules made before keep `contains`, so nothing changes for them; new rules from the dashboard default to `word`.
- The Rules page has "Apply to past transactions": it shows how many transactions would change first, and never touches categories you set by hand or anything into or out of Transfer. The CLI `node categorize.js --reapply-rules` still works.
- A rule whose text is only spaces no longer matches anything. Before, an "Anywhere" rule like that caught almost every transaction. The dashboard never allowed one, so this only matters if you added it with SQL.
- Rule text is now limited to 200 characters for new and edited rules. Longer (or empty) rules you already have keep working, but they can't be edited, and if you delete one there's no Undo: add it again shorter.
- **Roll back:** `supabase/rollbacks/20261206000000_rule_match_mode.down.sql` (every rule goes back to matching anywhere). Revert the Edge Functions and the sync too: they read `match_mode`.

### Refund links can't be changed by hand
- **Migration:** `20261205000000_lock_refund_of`. Apply it with `supabase db push --linked`, then `supabase functions deploy post-sync` (same release: refund pairing now skips rows you or a rule decided, and repairs half-applied pairs). No dashboard change, so the order doesn't matter.
- `refund_of` (which charge a refund reverses) is now set only by the refund pairing after each sync; a signed-in user changing it through the API gets "Bank-provided fields on transactions cannot be changed". Existing links are untouched.
- **Roll back:** `supabase/rollbacks/20261205000000_lock_refund_of.down.sql` (users can change `refund_of` again).

### Two-step sign-in
- **Migration:** `20261203000000_require_mfa`. Apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions (they call `mfa_satisfied`), then redeploy the dashboard.
- It sets PostgREST's pre-request hook (`pgrst.db_pre_request`) to `public.require_mfa`. If you already use your own hook, the migration stops with an error: call `public.require_mfa()` from your hook, clear it with `alter role authenticator reset pgrst.db_pre_request;` and `alter role authenticator in database postgres reset pgrst.db_pre_request;` (it may be set either way), push again, then set yours back the way it was. The check only sees a hook set on the database role: if yours is in PostgREST's own config (`db-pre-request` in its config file or `PGRST_DB_PRE_REQUEST`, on a self-run stack), move it into the database and chain it as above before pushing, or one of the two hooks may stop running.
- Settings has **Two-step sign-in**: scan a QR code with an authenticator app (1Password, Google Authenticator, Aegis, ...) and type its 6-digit code. From then on, sign-in asks for a code. The database enforces it: a session that skipped the code gets 403 on every API call (tables, views and functions), and the Edge Functions refuse it. Users without an authenticator are not affected.
- **Guessing codes:** Supabase allows about 15 code checks a minute per IP address and the dashboard stops at that limit. For stricter limits (lock an account after N wrong codes), add Supabase Auth's MFA verification attempt hook.
- **Changing the password in Settings** checks the current one without starting a new session (a new one would drop the code step). If you turned on Supabase Auth's "Secure password change" (off by default), a session older than 24 hours can't change the password: the dashboard says to sign out and sign in again.
- **Lost your phone?** There are no backup codes: add a second authenticator in Settings while you still have the first. If every authenticator is gone, the instance owner removes them in the Supabase SQL editor: `delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'you@example.com');`, then sets it up again.
- **Roll back:** `supabase/rollbacks/20261203000000_require_mfa.down.sql` (after reverting the Edge Functions). If you chained your own hook, remove its `require_mfa()` call first: the rollback stops while a hook still calls it, and it leaves your hook in place. Run it in the SQL editor or with `psql -v ON_ERROR_STOP=1 -1 -f <file>`, so a refusal stops it.

### Monthly budgets per category
- **Migration:** `20261202100000_category_budgets`. You apply it with `supabase db push --linked`, then redeploy the dashboard. No Edge Function or sync change.
- Adds `category_budgets`: a budget per category that holds from its month onward until you change it, with optional rollover (a month's leftover or overspend moves into the next). Only spend counts, never transfers or income. Budgets are in the export.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261202100000_category_budgets.down.sql` (budgets are lost; export your data before if you want to keep them). A dashboard of this release without the table cannot open Budgets, and its data export fails.

### Broker imports skip trades already imported
- **Migration:** `20261201000000_holding_trades_external_id`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: its broker import writes the new columns.
- Each trade can remember the broker it came from and the broker's own id for it (`holding_trades.source`, `holding_trades.external_id`, both optional). Re-importing the same broker file skips trades already there by id, and two identical buys on the same day stay two trades. Trades typed in or imported before keep both empty.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261201000000_holding_trades_external_id.down.sql` (the stored broker ids are lost; the trades stay).

### Credit cards and loans count as debt
- **Migration:** `20261130000000_account_types`. You apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions and the Docker/launchd sync (they read and write the new column), then redeploy the dashboard.
- Every account gets a type (`accounts.account_type`): checking, savings, credit card, loan, investment or other. New links take it from the bank; accounts linked before get it on their next sync (one extra bank call per account, once). Empty means unknown and counts as checking (a bank that sends no type gets checking). You can correct it in the dashboard.
- Credit cards and loans subtract from net worth, whatever sign the bank gives their balance. `v_net_worth_daily` has a new last column, `liabilities_eur` (positive); `bank_total_eur` leaves debts out and `total_eur` subtracts them.
- You can add a debt by hand (a manual loan account with a balance you update, removable once paid). Its balance keeps counting until you change it, without the 30-day limit of bank balances, at each day's exchange rate.
- CDs no longer count in net worth; data stays in the export until a later release drops the table.
- **Roll back:** `supabase/rollbacks/20261130000000_account_types.down.sql` (debt balances typed in by hand are deleted; account types are lost). The Edge Functions of this release read `account_type`: revert them too (the Node sync works either way).

### Rules can only set how a row counts
- **Migration:** `20261129000000_flow_only_rules`. Apply it with `supabase db push --linked` BEFORE redeploying the dashboard: "It's a transfer" in the To review list saves a rule that sets only the flow.
- The `at_least_one_action` check on `category_rules` now also accepts a rule that sets only `set_flow_type`, and is added on databases that didn't have it.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261129000000_flow_only_rules.down.sql` (it deletes rules that set only the flow).

### Transfers between your own accounts stop counting as spend and income
- **Migration:** `20261128000000_transfer_detection`. You apply it with `supabase db push --linked` BEFORE redeploying the Edge Functions and the Docker/launchd sync (they write the new columns), then redeploy the dashboard.
- Every transaction now remembers who decided whether it is spend, income or a transfer (`flow_source`). Every flow set before this release is marked `legacy`: it never changes by itself, and the dashboard can list the ones that look wrong for you to review.
- The sync notes whether the other side of a payment is one of your own accounts (only yes or no is stored, never the IBAN), and such payments become transfers.
- After each sync, a debit on one of your accounts and the same amount credited on another within 4 days are paired as a suggested transfer. The dashboard lets you confirm it or say it is not a transfer; a rejected pair is never proposed again.
- A rule can now say how matching rows count (`category_rules.set_flow_type`).
- **Roll back:** `supabase/rollbacks/20261128000000_transfer_detection.down.sql` (flows already set stay; who set them and the pairs are dropped). The Node sync of this release writes `flow_source`: revert it too.

### Sync cursors follow their account; bank links keep the server's clock
- **Migration:** `20261127000000_cursor_fk_and_consent_clock`. You apply it with `supabase db push --linked`, then redeploy the Edge Functions and the dashboard.
- A deleted account no longer leaves its sync cursor behind; cursors of accounts already deleted are removed.
- A pending bank link always takes the database's time, so its 15-minute window can't be stretched.
- The bank's one-time code now reaches the dashboard in the URL fragment (`#bank_code=`), which browsers never send to the dashboard's host or its logs.
- **Roll back:** `supabase/rollbacks/20261127000000_cursor_fk_and_consent_clock.down.sql` (deleted orphan cursors are not restored).

### Bank payloads no longer keep other people's IBANs
- **Migration:** `20261126000000_raw_without_accounts`. You apply it with `supabase db push --linked`, then redeploy the Edge Functions.
- `transactions.raw` (the bank's payload, kept for support and export) stored the counterparty's account number on transfers. The sync now leaves it out, and the migration removes it from stored rows. Nothing in the app used it; every other field stays.
- **Not reversible:** the removed numbers can't be restored. Want them? Download the export (Settings → Your data) before you apply it.

### Delete your account from Settings
- **Migration:** `20261125000000_account_deletion`. You apply it with `supabase db push --linked`, then redeploy the Edge Functions and the dashboard.
- Deleting a user used to fail: most tables pointed at the user with no delete rule. They now cascade, so deleting a user (Settings → Delete account, or Supabase Auth → Users) removes all their rows, including investments and coins, and deleting an account removes its transactions.
- The instance owner (the first user) can't delete themselves from Settings while other users exist: the next user would silently become owner.
- Settings asks for your password again before deleting (checked by the server).
- New server-only table `bank_sessions` remembers each Enable Banking session, so deleting your account also closes it at the bank. Links made before this release are not in it; their consent simply expires.
- **Roll back:** `supabase/rollbacks/20261125000000_account_deletion.down.sql`.

### Bank links finish in the signed-in dashboard
- **Migration:** `20261124000000_sync_all_banks_skip_manual` (manual accounts are no longer sent to the bank sync). Redeploy the Edge Functions and the dashboard together (run the installer again, or `supabase functions deploy` + redeploy the dashboard). A new backend with an old dashboard leaves new bank links unfinished until the dashboard is updated.
- The bank's redirect used to store the accounts under whoever *started* the link, so on an instance with several users, one could send another their own consent URL and receive that person's accounts. `bank-consent-callback` now only forwards the browser; the new `complete-bank-consent` links the accounts for the signed-in user, and only if that user started the link.
- Your Enable Banking redirect URL does not change.
- A newly linked account starts its first sync right away (balance and transactions) instead of waiting up to 6 hours for the cron. It uses the same secret key as the cron, so nothing to configure.
- An old dashboard shows "Couldn't link the bank" for new links until you redeploy it.
- **Roll back:** `supabase/rollbacks/20261124000000_sync_all_banks_skip_manual.down.sql`.

## v0.1.0 and earlier

### Splitwise balances say who owes whom
- **Migration:** `20261123000000_splitwise_balances_basis`. Apply it with `supabase db push --linked`, then redeploy the dashboard.
- Each stored Splitwise balance says what it means: `group` (a member's net toward the whole group, how balances were stored before) or `pairwise` (what you owe that member), which the dashboard now writes. Rows saved before, or by an older dashboard, stay `group` and are never read as per-person debts.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261123000000_splitwise_balances_basis.down.sql`.

### Subscriptions radar: merchant keys and recurring streams
- **Migrations:** `20261119000000_merchant_key`, `20261119000001_aliases_by_merchant_key`, `20261119000002_alias_exact_first`, `20261120000000_recurring_streams`, `20261120000001_schedule_detect_recurring`, `20261121000000_recurring_streams_v2`, `20261122000000_recurring_streams_variant_dismissal`. Apply them with `supabase db push --linked` BEFORE redeploying the Edge Functions (`supabase functions deploy`: the bank sync writes `merchant_key`, and `detect-recurring` is new), then redeploy the dashboard. `20261120000001` needs the pg_cron setup of `20261118000000_schedule_sync` below.
- Each transaction and alias gets a normalized merchant name (`merchant_key`, written by the sync only), so "LIDL 4521" and "LIDL 4521 MILANO IT" group together and share one rename. An alias for an exact name still wins over one for the key.
- Recurring charges are detected every 6 hours into `recurring_streams` (the Subscriptions page). Your old subscription choices carry over; a name you dismissed no longer hides charges of another name you kept.
- **Roll back:** newest first, after reverting the dashboard, the detector and the sync: `20261122000000`, `20261121000000`, `20261120000001`, `20261120000000`, `20261119000002`, `20261119000001`, then `20261119000000` (each `supabase/rollbacks/<name>.down.sql`). Streams and merchant keys are lost; the transactions stay.

### The sync runs inside Supabase (pg_cron)
- **Migrations:** `20261117000000_sync_all_banks` and `20261118000000_schedule_sync`. First set the two Vault secrets `project_url` and `sync_bank_secret_key` (see the top of `20261117000000_sync_all_banks.sql`; `npx create-alopex` sets them), deploy the Edge Functions (`supabase functions deploy`), then `supabase db push --linked`.
- **Stop your other scheduler at the same time** (launchd, the Docker `scheduler.js`, or the GitHub Actions `sync.yml`): two schedulers double the bank calls, and banks allow about 4 unattended calls a day per account.
- pg_cron then syncs every bank account every 6 hours, followed by post-sync, prices and notifications (times in UTC). A job only queues its request: look for failures in `net._http_response` (query at the top of `20261118000000_schedule_sync.sql`).
- **Roll back:** `supabase/rollbacks/20261118000000_schedule_sync.down.sql` (stops the schedule; restart your old scheduler, or nothing syncs), then `supabase/rollbacks/20261117000000_sync_all_banks.down.sql`.

### Splitwise undo keeps how a row counts
- **Migration:** `20261116000000_splitwise_undo_keeps_flow`. You apply it with `supabase db push --linked`.
- Undoing a Splitwise import no longer resets spend/income on bank rows it only gave a share; only rows the import marked as transfers are reset.
- **Roll back:** `supabase/rollbacks/20261116000000_splitwise_undo_keeps_flow.down.sql`.

### Your own categories
- **Migration:** `20261115000000_user_categories`. You apply it with `supabase db push --linked`. Until then everyone has the built-in categories, as before.
- Adds `user_categories`: add categories of your own or hide built-in ones you don't use (Settings → Categories in the dashboard). The AI categorizes with your list. Transfer and Income can't be hidden.
- **Roll back:** `supabase/rollbacks/20261115000000_user_categories.down.sql`. Transactions keep the category names they have.

### Net worth keeps a bank that didn't sync, and counts deposits
- **Migration:** `20261114000000_net_worth_bank_carry_and_deposits`. You apply it with `supabase db push --linked`. No dashboard change needed.
- A bank whose sync failed on a day (an expired consent, say) dropped out of that day's net worth. Each account now keeps its last balance for up to 30 days.
- Deposits (CDs) now count in net worth, inside cash, from their start until they mature.
- **Roll back:** `supabase/rollbacks/20261114000000_net_worth_bank_carry_and_deposits.down.sql`.

### Spending and subscription view fixes
- **Migration:** `20261113000000_spend_and_subscription_views`. You apply it with `supabase db push --linked`. No dashboard change needed.
- Spending: a month with imported totals and Splitwise shares listed each category twice; now once, with the same total.
- Subscriptions: a shared plan counted at full price; it now counts your share when one is set.
- **Roll back:** `supabase/rollbacks/20261113000000_spend_and_subscription_views.down.sql`.

### Selling or changing a holding moves net worth at once
- **Migration:** `20261112000000_set_holding_quantity`. You apply it with `supabase db push --linked`. Until then the dashboard changes the quantity as before, and net worth follows at the next price sync.
- Adds `set_holding_quantity`: changing a quantity (or Mark as sold) also writes today's value from the latest price. Before, net worth kept the old value until the price sync ran, and for good where it doesn't.
- **Roll back:** `supabase/rollbacks/20261112000000_set_holding_quantity.down.sql`.
### Import a statement PDF
- **Deploy the function and set its key:** `supabase functions deploy parse-statement`, then `supabase secrets set GEMINI_API_KEY=<the key in your .env>`. No migration.
- The dashboard's statement import also takes PDFs: Gemini reads the transactions, you check them and confirm. The PDF is sent to Gemini and not stored here.
- **Privacy:** the whole PDF goes to Google, with your name, address and IBAN. On Gemini's free tier Google may use what you send to improve its products, and people may review it. Use a key from a paid (billing-enabled) project if that matters to you; categorization sends transaction descriptions to the same key.
- Needs the manual transactions migration (`20261111000000_manual_transactions`) applied.

### Add transactions by hand
- **Migration:** `20261111000000_manual_transactions`. You apply it with `supabase db push --linked`. Apply it before deploying the dashboard with the "+" button; until then adding says the update is missing.
- **Sync:** pull the new code too. The bank sync now skips manual accounts. An older sync would try to fetch them from Enable Banking and log errors.
- Adds `add_manual_transaction` and a `manual` flag on accounts: each source you name ("Fineco", "Cash") gets a hidden manual account. The amount, date and description of a manual transaction can be edited; bank rows stay read-only. Manual accounts don't appear in the accounts list or in net worth.
- **Roll back:** revert the dashboard and the sync first, then `supabase/rollbacks/20261111000000_manual_transactions.down.sql`. This deletes every transaction you added by hand.

### Delete a holding
- **Migration:** `20261110000000_delete_holding`. You apply it with `supabase db push --linked`. Apply it before deploying the dashboard that has the Delete button; until then deleting says the update is missing.
- Adds `delete_holding`, which deletes one of your investments or crypto holdings for good, with its price history and trades. Its value also leaves your past net worth. Use "Mark as sold" instead for something you really sold.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261110000000_delete_holding.down.sql`. Holdings already deleted stay deleted.

### Adding a holding: no more silent zero, clearer errors
- **Deploy the function:** `supabase functions deploy add-holding`. No migration.
- A holding is refused when it has no valid price or no exchange rate, instead of being saved and shown at 0. A missing rate is fetched on the spot.
- Search and add errors now say what failed, for example that CoinGecko is limiting requests.

### Exchange rates for every currency
- **No migration, no deploy:** `fx-sync.js` now stores every currency Frankfurter publishes (about 30 rows a day) instead of USD, GBP and CHF. A holding that showed 0 because its currency had no rate, CAD for example, gets its value at the next sync.

### Splitwise corrections
- **Migration:** `20261109000000_splitwise_corrections`. You apply it with `supabase db push --linked`. Apply it before using corrections in the dashboard; until then that screen says the update is missing, and importing still works.
- Adds `apply_splitwise_corrections`, which applies the rows you tick: added late, edited or removed in Splitwise. A removed row linked to a bank transaction clears its personal amount; an edited one recalculates it. Undo does not cover corrections.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261109000000_splitwise_corrections.down.sql`. Corrections already applied stay.

### Past-price backfill removed
- **No migration.** `backfill-price-history.js` no longer runs in the sync: total return needs only the latest price, and the script could take up to 8 minutes per sync. The `price_history` table and its rows stay, harmlessly.
- `COINGECKO_DEMO_API_KEY` is no longer used; you can remove it from `.env`.
- **Roll back:** revert the code.

### Your trades, for real performance (database part)
- **Migration:** `20261108000000_holding_trades`. You apply it with `supabase db push --linked`. Apply it before deploying the dashboard that uses it; until then that dashboard says the update is missing.
- Adds the `holding_trades` table (your buys and sells, only you can see or change them). `holding_performance` now also returns holdings sold to zero that have trades.
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261108000000_holding_trades.down.sql`. This deletes your trades, so export them first.

### Past prices for price returns (backfill)
- **No migration of its own; needs `20261107000000_price_history_and_holding_performance`.** Apply that with `supabase db push --linked` first. Until then the new step prints `price_history not found: apply the latest migration` and does nothing; the rest of the sync is unaffected.
- New `backfill-price-history.js`: fetches up to a year of past daily prices (Yahoo for stocks and funds, CoinGecko for coins) into `price_history`, only for holdings that have little of it. It runs as the last step of the daily sync, so a holding you add gets its history on the next sync. To fill everything now, run `node backfill-price-history.js` once (`--force` refetches all). Safe to re-run.
- A symbol Yahoo or CoinGecko will not answer for is counted as failed (`Price history: N filled, M failed, K already complete`) and retried next sync; the dashboard shows "since <date>" for it. CoinGecko's free tier is slow and rate limited (about 8 seconds between coins). An optional free demo key in `COINGECKO_DEMO_API_KEY` (see `.env.example`) helps.
- Nothing is written to `portfolio_snapshots` or `crypto_snapshots`, so net worth history is unchanged.
- **Roll back:** revert the code. The table stays until you run the migration's rollback.

### Price return for Portfolio and Crypto (database part)
- **Migration:** `20261107000000_price_history_and_holding_performance`. You apply it with `supabase db push --linked`; nothing applies it for you. Safe to apply before or after updating the dashboard.
- Adds the `price_history` table (past market prices, readable when signed in, written only by the sync) and the `holding_performance(p_from, p_last_move)` function the dashboard will call for price returns. It reads your holdings and prices only and writes nothing. `price_history` is never used by net worth.
- Until the price backfill ships (next release) the function works from your snapshots alone: ranges that start before your first snapshot show "since <date>".
- **Roll back:** revert the dashboard first, then `supabase/rollbacks/20261107000000_price_history_and_holding_performance.down.sql` (drops the function and the table; backfilled prices are lost and can be fetched again).

### Setup no longer asks for the dashboard address
- **No migration beyond `20261106000000_dashboard_origins`** (apply with `supabase db push --linked` first, then `supabase functions deploy`).
- `./setup.sh` has no "Dashboard address" question any more. Your dashboard registers its own address in `dashboard_origins` when the owner signs in, the Edge Functions allow those addresses in CORS, and a bank link returns to the address that started it. For GitHub installs setup prints the three Vercel values, then waits for that first sign-in and ends with `Done! Open <address>, sign in as <email>`.
- Existing installs: nothing breaks. `FRONTEND_URL` stays set and is still accepted; your dashboard registers itself on the next sign-in once it runs the matching my-wealth-view version. `./setup.sh --dashboard-url https://...` still works if bank linking ever returns to the wrong address.
- To forget a registered address (an old domain): in the Supabase SQL editor, `delete from dashboard_origins where origin = 'https://old.example.com';`.
- **Roll back:** revert the code first, then `supabase/rollbacks/20261106000000_dashboard_origins.down.sql`.

### Accounts show the bank's name and logo
- **Migration:** `20261105000000_account_bank`. Apply it with `supabase db push --linked` BEFORE redeploying `bank-consent-callback` (`supabase functions deploy bank-consent-callback`), then update the dashboard. A callback deployed before the migration fails every bank link, because it writes columns that don't exist yet.
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
- **Migration:** `20261104000000_account_eb_uid`. Apply it with `supabase db push --linked`, then redeploy `bank-consent-callback` (`supabase functions deploy bank-consent-callback`). Until the migration is applied the sync logs a warning and keeps using the old ids, so a renewed bank still stops when its old consent ends.
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
- **Migration:** `20261101000000_holdings_self_service`. Apply with `supabase db push --linked`. **Deploy the new function:** `supabase functions deploy add-holding`.
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
- **Migration:** `20261031000000_splitwise_import_keeps_edits`. Apply with `supabase db push --linked`.
- **Why:** importing the same group and date range again deleted every row in the range and reinserted it from the file, so a description or category you had edited was lost.
- **Effect:** rows already stored (matched by fingerprint) keep their edited description and category; an empty category is filled from the file. New rows are inserted and rows the file no longer has are deleted. An expense you change in Splitwise itself gets a new fingerprint, so edits on it are still lost.
- **Roll back:** the matching file in `supabase/rollbacks/`.

### EUR views keep every row, net worth no longer dips
- **Migrations:** `20261029000000_fx_eur_fallback`, `20261030000000_net_worth_carry_forward`. Apply with `supabase db push --linked`.
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
- Rollback files moved from `supabase/migrations/` to `supabase/rollbacks/`, so `supabase db push --linked` no longer trips over them.
- `merchant_aliases` (`20261027000000`) and `net_worth_daily_bonds` (`20261028000000`) were added to this repo. If you already created them by hand or from the frontend repo, `supabase db push --linked` fails with `Found local migration files to be inserted before the last migration on remote database` and suggests `--include-all`. Do not use `--include-all`: it would re-run the `create table` and fail with "already exists". Mark them applied instead: `supabase migration repair --status applied 20261027000000 20261028000000`, then `supabase db push --linked` again. (Tested on a local Supabase: after the repair, push reports the database is up to date.)

## Known limits
- Portfolio, crypto and notification scripts are single-user (`USER_ID`). Bank sync is multi-user.
- Nothing trims old data. Daily net worth snapshots, FX rates and transactions are kept forever. The dashboard reads at most 1000 rows per query, which daily net worth would reach after about 2.6 years of daily snapshots.
