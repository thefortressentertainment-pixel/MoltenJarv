#!/usr/bin/env bash
# One-time setup so Jarv can power the Mac down reliably.
#
# Adds a sudoers rule letting YOUR user run `sudo -n /sbin/shutdown -h now`
# without a password, so Jarv's shutdown force-halts instead of waiting on
# apps/dialogs (which is why the previous shutdown silently failed).
#
# Safe: it validates with `visudo -c` and auto-reverts if anything is wrong.
#
# Run once (it will ask for your Mac password):
#   bash scripts/setup-shutdown.sh
set -eo pipefail

echo "This will let Jarv power the Mac down without a password prompt."
echo "It adds ONE sudoers rule for your user ($USER). Reversible:"
echo "    sudo rm /etc/sudoers.d/jarv-shutdown"
echo
echo "Press Enter to continue, or Ctrl-C to cancel."
read -r _

# Cache your password for the next few minutes of sudo calls.
sudo -v

RULE="$USER ALL=(root) NOPASSWD: /sbin/shutdown"

# 0) Sanity: the existing sudoers must already be valid before we touch it.
if ! sudo visudo -c >/dev/null 2>&1; then
  echo "ERROR: existing /etc/sudoers is already invalid — fix that first. Aborting." >&2
  exit 1
fi

# 1) Create the drop-in rule.
sudo mkdir -p /etc/sudoers.d
echo "$RULE" | sudo tee /etc/sudoers.d/jarv-shutdown >/dev/null
sudo chmod 440 /etc/sudoers.d/jarv-shutdown

# 2) Make sure /etc/sudoers actually includes /etc/sudoers.d.
if sudo grep -qE '@includedir /etc/sudoers\.d|#includedir /etc/sudoers\.d' /etc/sudoers; then
  echo "already included: /etc/sudoers.d"
else
  echo '@includedir /etc/sudoers.d' | sudo tee -a /etc/sudoers >/dev/null
  echo "added: @includedir /etc/sudoers.d"
fi

# 3) Validate. If sudoers broke, revert both edits.
if ! sudo visudo -c >/dev/null 2>&1; then
  echo "ERROR: sudoers validation failed — reverting." >&2
  sudo sed -i '' '$d' /etc/sudoers 2>/dev/null || true
  sudo rm -f /etc/sudoers.d/jarv-shutdown
  echo "Reverted. Your sudo is unchanged. Nothing to fix on your end." >&2
  exit 1
fi

# 4) Confirm the rule is active.
if sudo -n -l 2>/dev/null | grep -q 'NOPASSWD: /sbin/shutdown'; then
  echo
  echo "SUCCESS — passwordless shutdown is enabled for your user."
  echo "Jarv can now power the Mac down with:  jarv-genie shutdown"
  echo "Test it from Telegram whenever you're ready."
else
  echo
  echo "WARNING: the rule was written and sudoers is valid, but 'sudo -n -l'"
  echo "did not list it yet (may need a moment, or a re-login)." >&2
  echo "Re-run this script to confirm, or check with:  sudo visudo -c" >&2
  exit 1
fi
