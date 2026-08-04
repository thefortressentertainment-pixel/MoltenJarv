#!/usr/bin/env bash
# Install the Jarv Genie launchd services on macOS:
#   - hub: always-on web hub bound to 0.0.0.0 (phone/LAN/Tailscale access, token-auth on /api/*)
#   - agent: scheduled daemon (Moltbook heartbeat, monitors, briefings)
#
# Usage: bash scripts/install-services.sh
set -euo pipefail

LAUNCH_DIR="$HOME/Library/LaunchAgents"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
DIST="$REPO_DIR/dist/index.js"

mkdir -p "$LAUNCH_DIR"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

write_plist() {
  local label="$1" extra="$2" out="$3"
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIST</string>
        $extra
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
</dict>
</plist>
EOF
}

# Always-on web hub (phone/LAN/Tailscale access).
write_plist "com.fortress.jarvgenie-hub" "<string>hub</string><string>--host</string><string>0.0.0.0</string><string>--port</string><string>3001</string><string>--no-open</string>" "$LAUNCH_DIR/com.fortress.jarvgenie-hub.plist"

# Scheduled daemon (heartbeats, monitors).
write_plist "com.fortress.jarvgenie-heartbeat" "<string>agent</string>" "$LAUNCH_DIR/com.fortress.jarvgenie-heartbeat.plist"

for svc in com.fortress.jarvgenie-hub com.fortress.jarvgenie-heartbeat; do
  launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$svc.plist"
  echo "loaded $svc"
done

echo "done. hub reachable at: $NODE_BIN $DIST hub --url"
