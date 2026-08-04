import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataHome } from '../config/defaults.js';

/**
 * Reliable macOS shutdown with post-boot verification.
 *
 * 1. Record the intent (durable, before anything else).
 * 2. Try a force-halt via `sudo -n /sbin/shutdown -h now` (no app-blocking
 *    dialogs). Requires a one-time sudoers entry (scripts/setup-shutdown.sh).
 * 3. Fall back to a graceful System Events shutdown.
 *
 * Because the machine powers off mid-call, the caller cannot "confirm" success
 * synchronously — so on the next boot `verifyLastShutdown()` cross-checks the
 * recorded request against the actual boot time to prove the Mac really went off.
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

/** Parse the ISO timestamp of the most recent shutdown request, if any. */
export function lastShutdownRequest(): Date | null {
  try {
    const lines = fs.readFileSync(shutdownLogPath(), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? '';
      const t = new Date(line.split(' ')[0] ?? '');
      if (!Number.isNaN(t.getTime())) return t;
    }
  } catch {
    /* no log */
  }
  return null;
}

/** Current boot time from `sysctl kern.boottime`. */
export async function bootTime(): Promise<Date | null> {
  try {
    const res = await execFileAsync('sysctl', ['kern.boottime']);
    const m = /sec\s*=\s*(\d+)/.exec(res.stdout);
    const sec = Number(m?.[1]);
    if (!Number.isNaN(sec) && sec > 0) return new Date(sec * 1000);
  } catch {
    /* sysctl unavailable */
  }
  return null;
}

/**
 * Verify the most recent shutdown actually happened: if the current boot time
 * is AFTER the last recorded shutdown request, the Mac really powered off
 * (and back on). Returns a plain-language result.
 */
export async function verifyLastShutdown(): Promise<string> {
  const requested = lastShutdownRequest();
  const boot = await bootTime();
  if (!requested) return 'no shutdown has been recorded yet — nothing to verify';
  if (!boot) return `last shutdown requested ${requested.toISOString()}, but boot time could not be read`;
  if (boot.getTime() > requested.getTime()) {
    return `verified: shutdown was requested ${requested.toISOString()}, and the Mac powered off and booted back up at ${boot.toISOString()}`;
  }
  return `NOT verified: shutdown was requested ${requested.toISOString()}, but the Mac did not power off (booted ${boot.toISOString()}, before the request)`;
}

export async function powerDown(source: string): Promise<{ ok: boolean; method: string; message: string }> {
  const line = recordShutdownRequest(source);

  // 1) Force-halt via passwordless sudo. When the system halts the child is
  //    killed, which surfaces as a `killed` error — that means it is working.
  try {
    await execFileAsync('sudo', ['-n', '/sbin/shutdown', '-h', 'now'], { timeout: 8000 });
    return { ok: true, method: 'sudo shutdown', message: `shutdown initiated via sudo at ${line.trim()}` };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string };
    if (e?.killed === true || e?.signal) {
      return { ok: true, method: 'sudo shutdown', message: `system halting via sudo at ${line.trim()}` };
    }
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
