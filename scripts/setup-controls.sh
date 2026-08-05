#!/usr/bin/env bash
# One-time setup so Jarv can toggle Wi-Fi (and Bluetooth where needed) without a
# password. Adds ONE sudoers rule letting YOUR user run, passwordless:
#   /usr/sbin/networksetup  (Wi-Fi — the write requires root)
#
# Bluetooth needs no elevation: blueutil toggles power as the normal user, so
# Jarv's bluetoothOn/bluetoothOff use it directly (no sudo, no password).
#
# Run once (it will ask for your Mac password):
#   bash scripts/setup-controls.sh
set -eo pipefail

echo "This lets Jarv toggle Wi-Fi without a password prompt."
echo "It adds ONE sudoers rule for your user ($USER). Reversible:"
echo "    sudo rm /etc/sudoers.d/jarv-controls"
echo
echo "Press Enter to continue, or Ctrl-C to cancel."
read -r _

sudo -v

RULES="$USER ALL=(root) NOPASSWD: /usr/sbin/networksetup"

# Ensure /etc/sudoers includes /etc/sudoers.d (idempotent).
if sudo grep -qE '@includedir /etc/sudoers\.d|#includedir /etc/sudoers\.d' /etc/sudoers 2>/dev/null; then
  echo "already included: /etc/sudoers.d"
else
  echo '@includedir /etc/sudoers.d' | sudo tee -a /etc/sudoers >/dev/null
fi

printf '%b\n' "$RULES" | sudo tee /etc/sudoers.d/jarv-controls >/dev/null
sudo chmod 440 /etc/sudoers.d/jarv-controls

if ! sudo visudo -c >/dev/null 2>&1; then
  echo "ERROR: sudoers validation failed — reverting." >&2
  sudo rm -f /etc/sudoers.d/jarv-controls
  echo "Reverted. Nothing to fix on your end." >&2
  exit 1
fi

echo
echo "SUCCESS — Wi-Fi toggles are enabled for Jarv (Bluetooth needs no setup)."
echo "Test from Telegram: \"turn off wifi\" or \"turn on bluetooth\"."
echo "To revoke later: sudo rm /etc/sudoers.d/jarv-controls"
