#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/dev.kp.tokenusage.sync.plist"
PLIST_DST="$HOME/Library/LaunchAgents/dev.kp.tokenusage.sync.plist"
LOG_DIR="$HOME/Library/Logs"
NODE_BIN="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Rewrite plist with absolute paths for this machine
sed \
  -e "s|__REPO_ROOT__|$ROOT|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__HOME__|$HOME|g" \
  "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Installed: $PLIST_DST"
echo "Schedule: daily 09:00 (local)"
echo "Log file: $LOG_DIR/tokenusage-sync.log"
echo "Test now: launchctl start dev.kp.tokenusage.sync"
