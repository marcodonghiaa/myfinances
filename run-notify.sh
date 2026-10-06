#!/bin/bash
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# mkdir is atomic and portable (flock does not exist on macOS)
mkdir /tmp/run-notify.lock.d 2>/dev/null || { echo "Previous notify run still running, skipping this run." >&2; exit 0; }
trap 'rmdir /tmp/run-notify.lock.d' EXIT
LOG_FILE="notify-log-$(date +%Y-%m-%d).txt"

echo "=== Notify check at $(date) ===" >> "$LOG_FILE"
/opt/homebrew/bin/node notify-worth-it.js >> "$LOG_FILE" 2>&1
