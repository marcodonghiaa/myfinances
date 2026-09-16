#!/bin/bash
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec 9>/tmp/run-notify.lock
flock -n 9 || { echo "Previous notify run still running, skipping this run." >&2; exit 0; }
LOG_FILE="notify-log-$(date +%Y-%m-%d).txt"

echo "=== Notify check at $(date) ===" >> "$LOG_FILE"
/opt/homebrew/bin/node notify-worth-it.js >> "$LOG_FILE" 2>&1
