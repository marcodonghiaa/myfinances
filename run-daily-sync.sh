#!/bin/bash
cd "/Users/marcodonghia/Developer/finance app"
LOG_FILE="sync-log-$(date +%Y-%m-%d).txt"

echo "=== Sync started at $(date) ===" >> "$LOG_FILE"
/opt/homebrew/bin/node sync-transactions.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node sync-networth.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node fx-sync.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node categorize.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node classify-type.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node sync-portfolio-prices.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node sync-crypto-coinbase.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node sync-crypto-prices.js >> "$LOG_FILE" 2>&1
echo "=== Sync finished at $(date) ===" >> "$LOG_FILE"