import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * One-time macOS permission setup. Run this from a Terminal on the Mac:
 *
 *   jarv-genie perms
 *
 * It probes every permission Jarv needs, reports what's missing, and opens the
 * exact System Settings panes. Click "Allow" once per pane and Jarv is fully
 * authorized — afterwards everything can be done remotely from Telegram with
 * zero clicks on the Mac. (macOS only lets you grant these from a logged-in
 * GUI session, which is why this is a one-time on-machine step.)
 */

const execFileAsync = promisify(execFile);

interface Check {
  label: string;
  ok: boolean;
  note: string;
}

async function osascript(script: string): Promise<boolean> {
  try {
    await execFileAsync('osascript', ['-e', script]);
    return true;
  } catch {
    return false;
  }
}

function settingsPane(pane: string): void {
  execFile('open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`], () => {});
}

export async function runPerms(): Promise<void> {
  const checks: Check[] = [];

  // Accessibility — System Events UI control.
  checks.push({
    label: 'Accessibility (System Events UI control)',
    ok: await osascript('tell application "System Events" to count processes'),
    note: 'needed to click/navigate other apps by UI',
  });

  // Screen recording.
  const shot = path.join(os.tmpdir(), 'jarv-perms-check.png');
  let screenOk = false;
  try {
    await execFileAsync('screencapture', ['-x', shot]);
    screenOk = fs.existsSync(shot);
  } catch {
    screenOk = false;
  } finally {
    try {
      fs.rmSync(shot, { force: true });
    } catch {
      /* ignore */
    }
  }
  checks.push({ label: 'Screen Recording (screenshots)', ok: screenOk, note: 'needed for screen_capture' });

  // Full Disk Access — reading protected folders (Desktop/Documents/Downloads).
  const tccDb = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
  let fda = false;
  try {
    fs.accessSync(tccDb, fs.constants.R_OK);
    fda = true;
  } catch {
    fda = false;
  }
  checks.push({ label: 'Full Disk Access (protected folders)', ok: fda, note: 'needed for files in Desktop/Documents/Downloads' });

  // Automation (Apple Events) — controlling Reminders/Clock/etc.
  checks.push({
    label: 'Automation (Apple Events → Reminders)',
    ok: await osascript('tell application "Reminders" to count lists'),
    note: 'needed for reminders; usually already granted',
  });

  let missing = false;
  for (const c of checks) {
    process.stdout.write(`${c.ok ? '[OK]   ' : '[MISS] '}${c.label} — ${c.note}\n`);
    if (!c.ok) missing = true;
  }

  if (!missing) {
    process.stdout.write('\nAll permissions granted. Jarv is fully authorized — remote operation from Telegram needs no Mac clicks.\n');
    return;
  }

  process.stdout.write('\nOpening System Settings for the missing permissions. Click ALLOW once for each.\n');
  if (checks.find((c) => c.label.startsWith('Accessibility') && !c.ok)) settingsPane('Privacy_Accessibility');
  if (checks.find((c) => c.label.startsWith('Screen Recording') && !c.ok)) settingsPane('Privacy_ScreenCapture');
  if (checks.find((c) => c.label.startsWith('Full Disk Access') && !c.ok)) settingsPane('Privacy_AllFiles');
  if (checks.find((c) => c.label.startsWith('Automation') && !c.ok)) settingsPane('Privacy_Automation');
  process.stdout.write('After allowing, re-run: jarv-genie perms  (it should then report all [OK])\n');
}
