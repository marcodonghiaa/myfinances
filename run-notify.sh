#!/bin/bash
cd "/Users/marcodonghia/Developer/finance app"
LOG_FILE="notify-log-$(date +%Y-%m-%d).txt"

echo "=== Notify check at $(date) ===" >> "$LOG_FILE"
/opt/homebrew/bin/node notify-worth-it.js >> "$LOG_FILE" 2>&1
