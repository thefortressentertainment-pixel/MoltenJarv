import { execFile } from 'node:child_process';
import { createPairingChallenge, trustedDeviceChatId } from '../telegram/trust.js';
import { dataHome } from '../config/defaults.js';

/**
 * `jarv-genie pair` — begin the verified-device pairing handshake.
 *
 * Creates a short, time-limited pairing code, shows it on the Mac's screen, and
 * (since the operator chose to) surfaces it as a macOS notification so they don't
 * have to keep the terminal in view. The operator then messages the Jarv bot:
 *   verify <code>
 * Only someone physically at this machine can see the code, so completing the
 * verify binds that Telegram chat id as the trusted device. Start the code's TTL
 * for ~5 minutes.
 */

function macNotify(text: string): void {
  if (process.platform !== 'darwin') return;
  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 300);
  execFile('osascript', ['-e', `display notification "${safe}" with title "Jarv Genie Pairing"`], () => {
    /* best effort — not fatal if notifications are unavailable */
  });
}

/** `jarv-genie pair` — show a one-time pairing code (terminal + macOS notification). */
export async function runPairCommand(): Promise<void> {
  const existing = trustedDeviceChatId();
  if (existing) {
    process.stdout.write(`A device is already paired (chat ${existing}).\n`);
    process.stdout.write('Start fresh with: jarv-genie pair --force\n');
  }
  const challenge = createPairingChallenge();
  const code = challenge.code;
  const ttlMin = Math.max(1, Math.round((challenge.expiresAt - Date.now()) / 60_000));
  const line =
    `Jarv pairing code  [expires in ${ttlMin} min]\n\n` +
    `      ${code}\n\n` +
    `In Telegram, message the Jarv bot:  verify ${code}`;
  process.stdout.write(line + '\n');
  macNotify(`Jarv pairing code: ${code}`);
}
