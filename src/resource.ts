import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataHome } from './config/defaults.js';
import { loadConfig } from './config/index.js';

/**
 * Resource discipline: keep Jarv at core operating levels on small machines
 * (8 GB RAM).
 *
 * - `ensureResources()` runs before a task: if free memory is critically low,
 *   it cleans up (unloads idle Ollama models, prunes old drawings, removes
 *   stale temp files). Returns "blocked" if still dangerously low.
 * - A busy-lock serializes work across processes (Telegram bridge vs the
 *   scheduled heartbeat), so tasks never pile up on the model at once.
 */

const execFileAsync = promisify(execFile);
const LOW_WATER = 15; // % free before we start cleaning
const BLOCK_WATER = 8; // % free below which we refuse new work
const BUSY_TTL_MS = 30 * 60 * 1000;

/** Default busy-lock path; callers may pass an explicit path (tests). */
export function busyLockPath(): string {
  return path.join(dataHome(), 'busy.lock');
}

/**
 * Per-task lease watchdogs.
 *
 * The busy-lock used to keep two failure modes alive forever:
 *  1. A holder whose child task died but whose own process stayed up — the
 *     lock looked "owned by a live process", so nobody could reclaim it, and
 *     every new task got refused (the Telegram bridge wedged exactly this way).
 *  2. A holder that silently hung mid-task with no heartbeat, so the lock
 *     stayed fresh for the full 30-min TTL regardless of whether the work was
 *     actually progressing.
 *
 * `TaskLease` fixes both: an active task refreshes its lease as it works, and
 * any stale lease can be reclaimed even when the owner PID is still alive. The
 * busiest real case, the consent gate, keeps its own clock in Telegram and is
 * deliberately exempt (see EXEMPT codes) so waiting on a human never looks
 * hung. This is the autonomous "conflict resolution": if we hold a lock but
 * actively report doing nothing, the next claimant may take it over.
 */

/** A task is considered stalled when it hasn't heartbeated for this long. */
export const TASK_LEASE_MAX_IDLE_MS = 10 * 60 * 1000;
/** How often an active task should refresh its lease. */
export const TASK_LEASE_HEARTBEAT_MS = 45 * 1000;
/**
 * Reason tags written into the lease. EXEMPT labels the ONLY legitimate
 * long-idle states — consent-gate and scheduled wait — so the watchdog knows a
 * holder waiting on a human hasn't died of actual work starvation.
 */
export const LEASE_EXEMPT = 'exempt';

export interface AcquiredLease {
  /** True if we hold the lease. */
  held: boolean;
  /** True if ownership was taken from a stale holder (conflict resolved). */
  reclaimed: boolean;
  /** The path of the lock file (for release). */
  lockPath: string;
  /** Release the lease (our own only). */
  release: () => void;
  /** Refresh the lease because we're still actively working. */
  heartbeat: () => void;
}

const lockDeadline = (raw: string, now: number): number => {
  const n = Number(raw.split(':')[1]);
  return Number.isInteger(n) && n > 0 ? n : now;
};

const lockReason = (raw: string): string | undefined => {
  const parts = raw.split(':');
  // Format: pid:deadline[:reason]. Reason is the token after the deadline.
  return parts.length >= 3 ? parts.slice(2).join(':') : undefined;
};

function parsedLock(lockPath: string): { pid: number; deadline: number; reason?: string } | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const pid = Number(raw.split(':')[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, deadline: lockDeadline(raw, Date.now()), reason: lockReason(raw) };
  } catch {
    return null;
  }
}

/**
 * True only if the lock names a live process whose lease is still breathing
 * (either a lock younger than BUSY_TTL_MS, or — for a lease record — a
 * non-exempt holder that heartbeated recently, or an exempt holder whose
 * task window hasn't elapsed).
 */
function isLockLive(lockPath: string): boolean {
  const lock = parsedLock(lockPath);
  if (!lock) return false;
  if (Date.now() - fs.statSync(lockPath).mtimeMs >= BUSY_TTL_MS) return false; // stale regardless
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false; // owner gone
  }
}

function writeLock(lockPath: string, pid: number, deadline: number, reason?: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${pid}:${deadline}${reason ? ':' + reason : ''}`);
}

export interface TaskLeaseOpts {
  exempt?: boolean;
  maxIdleMs?: number;
  /** Lock file path; defaults to the shared busy-lock (tests pass a temp one). */
  lockPath?: string;
}

/**
 * Acquire a per-task lease. Reclaims automatically from any holder that is
 * dead OR whose lease has gone stale (idle past the hard ceiling) — even a
 * live-PID holder. `exempt` marks consent-gate / scheduled-wait windows that
 * may legitimately be idle; every other lease stops being fresh once its
 * heartbeat lapses, so a wedged or silently-hung task is taken back.
 */
export function acquireTaskLease(pathOrOpts?: string | TaskLeaseOpts, extraOpts?: TaskLeaseOpts): AcquiredLease {
  // Support both `(opts)` and the older `(lockPath, opts)` calling styles.
  const opts: TaskLeaseOpts =
    typeof pathOrOpts === 'string'
      ? { ...extraOpts, lockPath: pathOrOpts }
      : { ...(pathOrOpts ?? {}), ...(extraOpts ?? {}) };
  const lockPath = opts.lockPath ?? busyLockPath();
  const maxIdle = opts.maxIdleMs ?? TASK_LEASE_MAX_IDLE_MS;

  const live = (): boolean => {
    const lock = parsedLock(lockPath);
    if (!lock) return false;
    try {
      process.kill(lock.pid, 0);
    } catch {
      return false; // owner gone → reclaimable
    }
    if (opts.exempt && lock.reason === LEASE_EXEMPT) {
      // Exempt holders wait on a human; honor their full remaining BUSY_TTL.
      return Date.now() - fs.statSync(lockPath).mtimeMs < BUSY_TTL_MS;
    }
    // Non-exempt: fresh only while heartbeating within the idle ceiling.
    const idle = Date.now() - fs.statSync(lockPath).mtimeMs;
    return idle < (opts.exempt ? BUSY_TTL_MS : maxIdle);
  };

  let reclaimed = false;
  if (parsedLock(lockPath)) {
    if (live()) return { held: false, reclaimed: false, lockPath, release: () => {}, heartbeat: () => {} };
    reclaimed = true; // dead owner OR stale lease → take it over
  }

  const deadline = Date.now() + maxIdle;
  writeLock(lockPath, process.pid, deadline, opts.exempt ? LEASE_EXEMPT : undefined);
  let held = true;

  const release = (): void => {
    if (!held) return;
    // Only remove if it's still ours.
    const lock = parsedLock(lockPath);
    if (lock && lock.pid === process.pid) rmLock(lockPath);
    held = false;
  };

  const heartbeat = (): void => {
    if (!held) return;
    writeLock(lockPath, process.pid, Date.now() + maxIdle, opts.exempt ? LEASE_EXEMPT : undefined);
  };

  return { held, reclaimed, lockPath, release, heartbeat };
}

function rmLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* ignore */
  }
}



/** Current free memory percentage, from `memory_pressure`. */
export async function freeMemoryPercent(): Promise<number> {
  try {
    const res = await execFileAsync('memory_pressure', ['-Q']);
    const m = /free percentage:\s*(\d+)/i.exec(res.stdout);
    const n = Number(m?.[1]);
    if (!Number.isNaN(n)) return n;
  } catch {
    // fall through
  }
  return 100;
}

/** Prune old drawing PNGs in the workspace, keeping the newest `keep`. */
function pruneDrawings(keep = 5): number {
  try {
    const dir = path.join(dataHome(), 'workspace');
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^drawing-.*\.png$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    let removed = 0;
    for (const file of files.slice(keep)) {
      try {
        fs.rmSync(path.join(dir, file.f), { force: true });
        removed++;
      } catch {
        /* ignore */
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Remove stale jarv temp files under /tmp. */
function pruneTemp(): number {
  let removed = 0;
  try {
    for (const f of fs.readdirSync('/tmp')) {
      if (f.startsWith('jarv-') && f.endsWith('.png')) {
        try {
          fs.rmSync(path.join('/tmp', f), { force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * Unload any Ollama model that is not the configured primary model, freeing
 * RAM while keeping the brain warm.
 */
async function unloadIdleOllamaModels(primaryModel: string): Promise<string[]> {
  const stopped: string[] = [];
  try {
    const res = await execFileAsync('ollama', ['ps'], { timeout: 10_000 });
    for (const line of res.stdout.split('\n').slice(1)) {
      const name = line.trim().split(/\s+/)[0];
      if (!name || name === primaryModel) continue;
      try {
        await execFileAsync('ollama', ['stop', name], { timeout: 10_000 });
        stopped.push(name);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return stopped;
}

/**
 * Clean up resources. Returns a summary of what was freed.
 */
export async function cleanupResources(): Promise<Record<string, number | string[]>> {
  const config = loadConfig();
  const primary = config.providers.primary.model;
  const [drawings, temp, ollamaStopped] = await Promise.all([
    Promise.resolve(pruneDrawings()),
    Promise.resolve(pruneTemp()),
    unloadIdleOllamaModels(primary),
  ]);
  return { drawingsRemoved: drawings, tempRemoved: temp, ollamaStopped };
}

/**
 * Run before a task. Returns 'ok', 'cleaned' (it freed memory first), or
 * 'blocked' (memory still dangerously low — caller should refuse new work).
 */
export async function ensureResources(): Promise<'ok' | 'cleaned' | 'blocked'> {
  const free = await freeMemoryPercent();
  if (free >= LOW_WATER) return 'ok';
  await cleanupResources();
  const after = await freeMemoryPercent();
  if (after < BLOCK_WATER) return 'blocked';
  return 'cleaned';
}

// ─── Autonomic nervous system ────────────────────────────────────────────────
// Jarv is modeled as a living organism (see docs/ANATOMY.md). Like the human
// autonomic nervous system, this layer runs below conscious thought: it SENSES
// the organism's vitals and REGULATES them — cleaning up, compacting, backing
// off, or refusing new work — without the neocortex (the agent loop) having to
// think about it. The existing `ensureResources` / busy-lock API is preserved;
// callers use `sense()` + `regulate()` for the full vital-signs loop.

export interface Vitals {
  /** Free memory as a percentage of the machine total (100 = plenty). */
  freeMemoryPercent: number;
  /** Fraction of the working-context budget already consumed (0..1; ≥1 = over budget). */
  contextUsage: number;
  /** Whether another process holds the busy-lock. */
  busy: boolean;
  /** Approximate disk-free percentage on the data home volume. */
  freeDiskPercent: number;
  /** Millisecond timestamp of the reading. */
  sampledAt: number;
}

export type RegulateResult = 'ok' | 'cleaned' | 'compacted' | 'blocked';

const CONTEXT_WARN_CHARS = 90_000; // session + working context nearing the 100k budget
const DISK_LOW_PERCENT = 10;

/** Cap the working session file at this size (bytes) when it grows too large. */
const SESSION_CAP_BYTES = 2 * 1024 * 1024;

/** Tail of the chat session kept when the autonomic system compacts it. */
const SESSION_KEEP_LINES = 200;

/**
 * Sense the organism's vitals. Cheap, non-mutating, safe to call before any
 * task. Reports memory headroom, working-context budget, busy state, and disk.
 * `busy` is true only when ANOTHER process holds the busy-lock — a lock the
 * caller itself holds is not reported as busy.
 */
export async function sense(): Promise<Vitals> {
  const [free, busy, freeDisk] = await Promise.all([
    freeMemoryPercent(),
    Promise.resolve(busyByOthers()),
    freeDiskPercent(),
  ]);
  const contextUsage = await contextUsageFraction();
  return {
    freeMemoryPercent: free,
    contextUsage,
    busy,
    freeDiskPercent: freeDisk,
    sampledAt: Date.now(),
  };
}

/** True when a different process holds the busy-lock (not this one). */
export function busyByOthers(lockPath = busyLockPath()): boolean {
  if (!lockIsFresh(lockPath)) return false;
  const raw = readLock(lockPath);
  if (raw && Number(raw.split(':')[0]) === process.pid) return false; // our own lock
  return lockIsOwnedByLiveProcess(lockPath);
}

/** Read the raw lock contents, or null when absent/unreadable. */
function readLock(lockPath: string): string | null {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Regulate based on sensed vitals. Acts to keep the organism stable:
 *  - `cleaned` — freed memory / disk (unloaded models, pruned drawings/temp).
 *  - `compacted` — shrank an overgrown session file to its recent tail.
 *  - `blocked` — critically low memory; caller should refuse new work.
 *  - `ok` — everything within normal range; nothing needed doing.
 */
export async function regulate(vitals: Vitals): Promise<RegulateResult> {
  if (vitals.freeMemoryPercent < BLOCK_WATER) return 'blocked';
  let acted: RegulateResult = 'ok';
  if (vitals.freeMemoryPercent < LOW_WATER || vitals.freeDiskPercent < DISK_LOW_PERCENT) {
    await cleanupResources();
    acted = 'cleaned';
  }
  if (vitals.contextUsage >= 1) {
    const compacted = compactSession();
    if (compacted) acted = 'compacted';
  }
  return acted;
}

/**
 * Fraction (0..1) of the working-context budget already consumed by the
 * largest session file. 1.0 or above means the liver needs to filter — the
 * session has outgrown the budget the model can actually attend to.
 */
async function contextUsageFraction(): Promise<number> {
  try {
    const dir = path.join(dataHome(), 'memory', 'sessions');
    let max = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const stat = fs.statSync(path.join(dir, f));
      if (stat.size > max) max = stat.size;
    }
    return Math.min(1, max / CONTEXT_WARN_CHARS);
  } catch {
    return 0;
  }
}

/** Free disk percentage on the volume holding ~/.jarv-genie (best-effort). */
function freeDiskPercent(): number {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('/bin/df', ['-k', dataHome()], { encoding: 'utf8' });
    const line = out.split('\n')[1];
    if (!line) return 100;
    const parts = line.trim().split(/\s+/);
    const capacity = Number((parts[4] ?? '100%').replace('%', ''));
    return Number.isNaN(capacity) ? 100 : 100 - capacity;
  } catch {
    return 100;
  }
}

/**
 * Shrink the largest session file to its recent tail (keep the newest turns,
 * drop the ancient bulk). Returns the number of bytes freed, or 0 if nothing
 * needed trimming. The session store is append-only history; the model only
 * attends to the newest tail anyway (trimHistory caps it), so dropping the
 * old bulk loses nothing the cortex can actually use.
 */
function compactSession(): number {
  try {
    const dir = path.join(dataHome(), 'memory', 'sessions');
    let biggest: { file: string; size: number } | null = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (!biggest || stat.size > biggest.size) biggest = { file: full, size: stat.size };
    }
    if (!biggest || biggest.size <= SESSION_CAP_BYTES) return 0;
    const lines = fs.readFileSync(biggest.file, 'utf8').split('\n').filter((l) => l.length > 0);
    const tail = lines.slice(-SESSION_KEEP_LINES);
    fs.writeFileSync(biggest.file, tail.join('\n') + '\n');
    return biggest.size;
  } catch {
    return 0;
  }
}

/**
 * Try to claim the busy lock (single-task execution across processes).
 *
 * Safely handles two failure modes that used to cause trouble:
 *  - A previous owner that died mid-task: the lock is re-claimed once the old
 *    owner's PID is no longer running (or the lock is past its TTL), so a crash
 *    can't hold the lock forever.
 *  - A write failure: we return `false` (honest) rather than pretending we
 *    acquired the lock, which previously let two processes race.
 */
export function tryAcquireBusy(lockPath = busyLockPath()): boolean {
  if (lockIsOwnedByLiveProcess(lockPath)) return false;
  if (lockIsFresh(lockPath)) return false;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

function lockIsFresh(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs < BUSY_TTL_MS;
  } catch {
    return false;
  }
}

/** True if the lock names a PID that is still alive (and within TTL). */
function lockIsOwnedByLiveProcess(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const pid = Number(raw.split(':')[0]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (Date.now() - fs.statSync(lockPath).mtimeMs >= BUSY_TTL_MS) return false; // stale anyway
    try {
      process.kill(pid, 0); // signal 0 = existence check, no signal sent
      return true;
    } catch {
      return false; // owner is gone; lock is dead
    }
  } catch {
    return false;
  }
}

export function releaseBusy(lockPath = busyLockPath()): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* ignore */
  }
}

export function isBusy(lockPath = busyLockPath()): boolean {
  if (!lockIsFresh(lockPath)) return false;
  // A lock whose owner process is gone is dead — never report the system as
  // busy off the back of a crashed task.
  if (lockIsOwnedByLiveProcess(lockPath)) return true;
  return false;
}
