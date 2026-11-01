#!/bin/bash
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# mkdir is atomic and portable (flock does not exist on macOS)
mkdir /tmp/run-daily-sync.lock.d 2>/dev/null || { echo "Previous sync still running, skipping this run." >&2; exit 0; }
trap 'rmdir /tmp/run-daily-sync.lock.d' EXIT
# cron and launchd start with a bare PATH: use the node on PATH, else Homebrew's.
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
LOG_FILE="sync-log-$(date +%Y-%m-%d).txt"

echo "=== Sync started at $(date) ===" >> "$LOG_FILE"
"$NODE" env-check.js >> "$LOG_FILE" 2>&1 || { echo "=== Sync skipped: fix .env (see above) ===" >> "$LOG_FILE"; exit 1; }
"$NODE" sync-transactions.js >> "$LOG_FILE" 2>&1
"$NODE" sync-networth.js >> "$LOG_FILE" 2>&1
"$NODE" fx-sync.js >> "$LOG_FILE" 2>&1
"$NODE" categorize.js >> "$LOG_FILE" 2>&1
"$NODE" classify-type.js >> "$LOG_FILE" 2>&1
"$NODE" categorize-splitwise.js >> "$LOG_FILE" 2>&1
"$NODE" classify-flow.js >> "$LOG_FILE" 2>&1
"$NODE" sync-portfolio-prices.js >> "$LOG_FILE" 2>&1
"$NODE" sync-crypto-coinbase.js >> "$LOG_FILE" 2>&1
"$NODE" sync-crypto-prices.js >> "$LOG_FILE" 2>&1
echo "=== Sync finished at $(date) ===" >> "$LOG_FILE"