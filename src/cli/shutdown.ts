import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataHome } from '../config/defaults.js';

/**
 * Reliable macOS shutdown. Logs the intent first (so Jarv can verify on the
 * next boot), then tries, in order:
 *   1. `sudo -n /sbin/shutdown -h now` — force-halts, no app-blocking dialogs.
 *      Requires a one-time sudoers entry (scripts/setup-shutdown.sh).
 *   2. `osascript ... System Events to shut down` — graceful, may wait on apps.
 */

const execFileAsync = promisify(execFile);

export function shutdownLogPath(): string {
  return path.join(dataHome(), 'shutdown.log');
}

/** Record the intent so the next boot can confirm the Mac actually powered off. */
export function recordShutdownRequest(source: string): string {
  const line = `${new Date().toISOString()} shutdown requested (${source})\n`;
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.appendFileSync(shutdownLogPath(), line);
  return line;
}

/** Read the log so Jarv can report when the last shutdown was requested. */
export function readShutdownLog(): string {
  try {
    return fs.readFileSync(shutdownLogPath(), 'utf8').trim() || '(no shutdowns logged)';
  } catch {
    return '(no shutdowns logged)';
  }
}

export async function powerDown(source: string): Promise<{ ok: boolean; method: string; message: string }> {
  const line = recordShutdownRequest(source);

  // 1) Force-halt via passwordless sudo (reliable; does not wait on apps).
  try {
    await execFileAsync('sudo', ['-n', '/sbin/shutdown', '-h', 'now'], { timeout: 8000 });
    return { ok: true, method: 'sudo shutdown', message: `shutdown initiated via sudo at ${line.trim()}` };
  } catch {
    // no passwordless sudo — fall through
  }

  // 2) Graceful shutdown via System Events.
  try {
    await execFileAsync('osascript', ['-e', 'tell application "System Events" to shut down'], { timeout: 15_000 });
    return { ok: true, method: 'system events', message: `shutdown initiated via System Events at ${line.trim()}` };
  } catch (err) {
    return { ok: false, method: 'none', message: `shutdown failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
