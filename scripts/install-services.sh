#!/usr/bin/env bash
# Install the Jarv Genie launchd services on macOS:
#   - hub: always-on web hub bound to 0.0.0.0 (phone/LAN/Tailscale access, token-auth on /api/*)
#   - agent: scheduled daemon (monitors, briefings)
#
# Usage: bash scripts/install-services.sh
set -eo pipefail

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
  local label="$1" extra="$2" out="$3" throttle="${4:-60}"
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
        <string>--max-old-space-size=1024</string>
        <string>$DIST</string>
        $extra
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>/tmp/${label}.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${label}.err</string>
</dict>
</plist>
EOF
}

# A plist that runs an arbitrary binary (used for the keep-awake daemon).
write_bin_plist() {
  local label="$1" args="$2" out="$3"
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        $args
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>/tmp/${label}.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${label}.err</string>
</dict>
</plist>
EOF
}

# Always-on web hub (phone/LAN/Tailscale access).
write_plist "com.fortress.jarvgenie-hub" "<string>hub</string><string>--host</string><string>0.0.0.0</string><string>--port</string><string>3001</string><string>--no-open</string>" "$LAUNCH_DIR/com.fortress.jarvgenie-hub.plist"

# Scheduled daemon (heartbeats, monitors). Higher ThrottleInterval so a crash
# (with KeepAlive=true) backs off for up to 5 minutes instead of hot-respawning
# in a loop. The in-code crash breaker handles real backoff; this is launchd's
# own floor on respawn rate.
write_plist "com.fortress.jarvgenie-heartbeat" "<string>agent</string>" "$LAUNCH_DIR/com.fortress.jarvgenie-heartbeat.plist" 300

# Keep the Mac awake as a 24/7 node: -u asserts UserIsActive (keeps the user
# session + network hot), -i prevents idle sleep, -s prevents system sleep,
# -m prevents disk idle — all while the display may still sleep.
# Note: closing the lid still suspends on Apple silicon regardless of
# caffeinate/pmset; keep the lid open (or nearly open) for true 24/7.
# Opt out with JARV_GENIE_NO_KEEPAWAKE=1.
if [ "${JARV_GENIE_NO_KEEPAWAKE:-0}" != "1" ]; then
  write_bin_plist "com.fortress.jarvgenie-keepawake" "<string>/usr/bin/caffeinate</string><string>-uism</string>" "$LAUNCH_DIR/com.fortress.jarvgenie-keepawake.plist"
  KEEPAWAKE_SVC=(com.fortress.jarvgenie-keepawake)
else
  KEEPAWAKE_SVC=()
fi

# Hands-free always-listening voice daemon (wake word). Opt in with
# JARV_GENIE_ENABLE_VOICE=1 — it keeps a microphone hot 24/7. Requires
# sox (`rec`) + whisper.cpp and mic permission, else the service crash-loops.
VOICE_SVC=()
if [ "${JARV_GENIE_ENABLE_VOICE:-0}" = "1" ]; then
  write_plist "com.fortress.jarvgenie-voice" "<string>voice</string><string>--wake</string><string>--quiet</string>" "$LAUNCH_DIR/com.fortress.jarvgenie-voice.plist"
  VOICE_SVC=(com.fortress.jarvgenie-voice)
fi

# Footprint mode. The HUB is the always-on Node daemon that serves /api/chat +
# /api/status — everything a phone, script, or Blender add-on needs to prompt Jarv
# on demand. The TELEGRAM bridge is ALSO always-on (when a bot token is set): it is
# the remote-consent + remote-call channel, so approvals and remote prompting keep
# working. The HEARTBEAT (scheduled/proactive/automation daemon) is a separate
# ~50MB Node process that is OPT-IN — dropped by default for a leaner footprint
# (e.g. while Blender/Unreal is open), re-enabled with JARV_GENIE_ENABLE_HEARTBEAT=1.
#
#   JARV_GENIE_ENABLE_HEARTBEAT=1   → also run the scheduled heartbeat daemon.
#   (default)                       → hub + telegram (+ keepawake/voice); no heartbeat.

# Telegram bridge (remote chat + explicit-consent approvals) — always on when a
# bot token is set, so the consent/remote channel stays available. Needs only the
# bot token; the first person to message the bot becomes the owner.
TELEGRAM_SVC=()
if python3 -c "
import json,os
try:
    s=json.load(open(os.path.expanduser('~/.jarv-genie/secrets.json')))
except Exception:
    s={}
import sys; sys.exit(0 if s.get('TELEGRAM_BOT_TOKEN') else 1)
" 2>/dev/null; then
  TELEGRAM_SVC=(com.fortress.jarvgenie-telegram)
  echo "telegram bridge configured — will run (consent/remote channel available)"
else
  echo "telegram bridge not configured (set TELEGRAM_BOT_TOKEN to enable remote channel)"
fi

# Scheduled/heartbeat daemon — OPT-IN for a lean footprint.
HEARTBEAT_SVC=()
if [ "${JARV_GENIE_ENABLE_HEARTBEAT:-0}" = "1" ]; then
  HEARTBEAT_SVC=(com.fortress.jarvgenie-heartbeat)
  echo "heartbeat scheduled daemon enabled (JARV_GENIE_ENABLE_HEARTBEAT=1)"
else
  echo "heartbeat scheduled daemon is OPT-IN (JARV_GENIE_ENABLE_HEARTBEAT=1) — not running for lean footprint"
fi

SERVICES=(com.fortress.jarvgenie-hub "${HEARTBEAT_SVC[@]}" "${KEEPAWAKE_SVC[@]}" "${VOICE_SVC[@]}" "${TELEGRAM_SVC[@]}")

# Unload services this run deliberately does NOT select (so a re-run in lean mode
# actually drops a previously-running optional daemon like the heartbeat).
ALL_OPTIONAL=(com.fortress.jarvgenie-heartbeat com.fortress.jarvgenie-telegram com.fortress.jarvgenie-voice com.fortress.jarvgenie-keepawake)
for svc in "${ALL_OPTIONAL[@]}"; do
  if ! [[ " ${SERVICES[*]} " == *" $svc "* ]]; then
    launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
  fi
done

for svc in "${SERVICES[@]}"; do
  launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$svc.plist"
  echo "loaded $svc"
done

echo "done. hub reachable at: $NODE_BIN $DIST hub --url"
echo
echo "to make Jarv truly 24/7 (like a butler who never sleeps):"
echo "  sudo pmset -a sleep 0 disablesleep 1   # machine never sleeps on idle (lid must stay open on Apple silicon)"
echo "  System Settings > Users & Groups > auto-login   # it starts before you log in"
echo "  enable always-listening voice:  JARV_GENIE_ENABLE_VOICE=1 bash scripts/install-services.sh"
echo "  (you need sox + whisper.cpp and mic permission; run \`jarv-genie perms\` to check)"
