#!/usr/bin/env bash
set -euo pipefail

BUN_BIN=$(which bun || echo "/opt/homebrew/bin/bun")
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.local/state/cmux-orbit"
PLIST_PATH="$HOME/Library/LaunchAgents/com.felix.cmux-orbit.plist"

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"

cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.felix.cmux-orbit</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>run</string>
    <string>$REPO_DIR/src/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>4400</string>
    <key>ORBIT_HOST</key>
    <string>127.0.0.1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/orbit.out.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/orbit.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.felix.cmux-orbit" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "cmux-orbit background daemon installed and running on port 4400!"
