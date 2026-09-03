#!/bin/bash
cd "/Users/marcodonghia/Desktop/finance app"
LOG_FILE="sync-log-$(date +%Y-%m-%d).txt"

echo "=== Sync started at $(date) ===" >> "$LOG_FILE"
/opt/homebrew/bin/node sync-transactions.js >> "$LOG_FILE" 2>&1
/opt/homebrew/bin/node sync-net-worth.js >> "$LOG_FILE" 2>&1
echo "=== Sync finished at $(date) ===" >> "$LOG_FILE"