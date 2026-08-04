#!/usr/bin/env bash
# One-time setup so Jarv can power the Mac down reliably.
#
# By default, only root may run `shutdown`, and macOS's GUI shutdown via
# AppleScript is unreliable. This adds a sudoers rule letting YOUR user run
# `sudo -n /sbin/shutdown -h now` WITHOUT a password, so Jarv's shutdown always
# force-halts instead of waiting on apps/dialogs.
#
# Run once (it will ask for your Mac password):
#   bash scripts/setup-shutdown.sh
set -e

echo "This will let Jarv power the Mac down without a password prompt."
echo "It adds one sudoers rule for your user ($USER). Safe and reversible."
echo "Press Enter to continue, or Ctrl-C to cancel."
read -r _

# Verify sudo works at all, prompting for the password once.
sudo -v

RULE="$USER ALL=(root) NOPASSWD: /sbin/shutdown"
if sudo -n -l 2>/dev/null | grep -q "NOPASSWD: /sbin/shutdown"; then
  echo "Already configured — passwordless shutdown is enabled."
else
  echo "$RULE" | sudo tee /etc/sudoers.d/jarv-shutdown >/dev/null
  sudo chmod 440 /etc/sudoers.d/jarv-shutdown
  echo "Configured: $RULE"
fi

echo
echo "Verify with:  sudo -n -l | grep shutdown"
echo "Jarv can now power the Mac down via:  jarv-genie shutdown"
echo "To revoke later:  sudo rm /etc/sudoers.d/jarv-shutdown"
