#!/usr/bin/env bash
# One-time setup so Jarv can toggle Wi-Fi and Bluetooth without a password.
# Adds sudoers rules letting YOUR user run, passwordless:
#   /usr/sbin/networksetup  (Wi-Fi)
#   /opt/homebrew/bin/blueutil (Bluetooth)
#
# Run once (it will ask for your Mac password):
#   bash scripts/setup-controls.sh
set -eo pipefail

echo "This lets Jarv toggle Wi-Fi and Bluetooth without a password prompt."
echo "It adds TWO sudoers rules for your user ($USER). Reversible:"
echo "    sudo rm /etc/sudoers.d/jarv-controls"
echo
echo "Press Enter to continue, or Ctrl-C to cancel."
read -r _

sudo -v

RULES="$USER ALL=(root) NOPASSWD: /usr/sbin/networksetup\n$USER ALL=(root) NOPASSWD: /opt/homebrew/bin/blueutil"

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
echo "SUCCESS — Wi-Fi and Bluetooth toggles are enabled for Jarv."
echo "Test from Telegram: \"turn off wifi\" or \"turn on bluetooth\"."
echo "To revoke later: sudo rm /etc/sudoers.d/jarv-controls"
