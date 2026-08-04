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
const BUSY_LOCK = path.join(dataHome(), 'busy.lock');
const BUSY_TTL_MS = 30 * 60 * 1000;

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

/** Try to claim the busy lock (single-task execution across processes). */
export function tryAcquireBusy(): boolean {
  try {
    const st = fs.statSync(BUSY_LOCK);
    if (Date.now() - st.mtimeMs < BUSY_TTL_MS) return false;
  } catch {
    // no lock yet
  }
  try {
    fs.mkdirSync(path.dirname(BUSY_LOCK), { recursive: true });
    fs.writeFileSync(BUSY_LOCK, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

export function releaseBusy(): void {
  try {
    fs.rmSync(BUSY_LOCK, { force: true });
  } catch {
    /* ignore */
  }
}

export function isBusy(): boolean {
  try {
    const st = fs.statSync(BUSY_LOCK);
    return Date.now() - st.mtimeMs < BUSY_TTL_MS;
  } catch {
    return false;
  }
}
