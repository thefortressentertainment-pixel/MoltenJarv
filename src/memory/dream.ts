import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelRouter } from '../providers/index.js';
import type { JarvGenieConfig } from '../config/index.js';
import type { Memory } from './index.js';
import type { MemoryFact } from './types.js';

/**
 * "Dream" — background memory consolidation, modeled on grok-build's
 * `xai-grok-memory/dream.rs` (Apache-2.0).
 *
 * Jarv's flat fact store grows by appends and never reconciles. Periodically an
 * LLM pass reads the mature facts and returns a consolidated list: near-duplicates
 * merged, contradictions resolved (newer truth wins), ephemera discarded,
 * durable facts (preferences, decisions, architecture) preserved. The store is
 * then rewritten destructively so memory stays clean over months.
 *
 * Safety properties (mirror grok-build):
 *  - **Cheapest-first gates**: enabled → elapsed ≥ minHours → enough facts.
 *  - **Recency guard**: skip any fact written < minAgeMs ago; never consolidate
 *    a fact the agent just learned.
 *  - **Single-flight lock**: a `<memory>/.dream-lock` file whose mtime doubles as
 *    "last consolidated at"; stale locks (dead PID, too old) are reclaimed.
 *  - **Fail-open**: any LLM error / invalid response aborts WITHOUT touching the
 *    store — consolidation is idempotent and destructive only on valid output.
 */

export interface DreamOptions {
  enabled?: boolean;
  /** Minimum hours between consolidation runs. */
  minHours?: number;
  /** Minimum mature facts required to bother consolidating. */
  minCount?: number;
  /** Don't consolidate facts written more recently than this. */
  minAgeMs?: number;
  /** Input cap (chars) for the consolidated fact bundle. */
  maxInputChars?: number;
}

export interface DreamResult {
  ran: boolean;
  reason?: string;
  before?: number;
  after?: number;
  dropped?: number;
}

const LOCK_FILE = '.dream-lock';

interface DreamLock {
  pid: number;
  ts: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → gone; EPERM → alive but not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class DreamLockFile {
  constructor(private file: string) {}

  private async read(): Promise<DreamLock | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as DreamLock;
      if (typeof parsed.pid === 'number' && typeof parsed.ts === 'number') return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private async write(lock: DreamLock): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // `w` (not `wx`): we own the decision to take the lock here; the caller's
    // write-then-re-read compare-and-swap guards against concurrent acquirers.
    await fs.writeFile(this.file, JSON.stringify(lock), { flag: 'w' });
  }

  /** Last-consolidated timestamp, if the lock is held by a live process. */
  async lastConsolidatedAt(): Promise<number> {
    const lock = await this.read();
    return lock && isProcessAlive(lock.pid) ? lock.ts : 0;
  }

  /** Try to acquire. Returns false when another live dream holds it. Stale
   *  (dead-PID or too-old) locks are reclaimed. Uses write-then-re-read CAS so a
   *  concurrent acquirer can't be silently clobbered. */
  async acquire(staleMs: number): Promise<boolean> {
    const mine: DreamLock = { pid: process.pid, ts: Date.now() };
    // Bounded so a persistent I/O error can't spin the caller forever.
    for (let attempt = 0; attempt < 50; attempt++) {
      const lock = await this.read();
      if (lock && isProcessAlive(lock.pid) && Date.now() - lock.ts < staleMs) return false;
      // No lock, or a stale one we may reclaim → attempt to take it.
      try {
        await this.write(mine);
        // Confirm we won the write: if someone else raced in after us, they'd have
        // overwritten our PID and we should back off.
        const now = await this.read();
        if (now && now.pid === process.pid && now.ts === mine.ts) return true;
      } catch {
        // write failed (e.g. permission) — treated as "can't acquire".
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  /** Stamp "consolidated now". Called after a successful run. */
  async stamp(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // Rewrite (not exclusive) since we already hold it.
    await fs.writeFile(this.file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }

  async release(): Promise<void> {
    const lock = await this.read();
    if (lock && lock.pid === process.pid) {
      try {
        await fs.unlink(this.file);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Facts the model produced, mapped back to stable fact records: exact-text
 *  matches keep their original id (so embedding vectors stay valid); new or
 *  merged facts get a fresh id and timestamp. */
export function mergeConsolidated(facts: MemoryFact[], texts: string[]): MemoryFact[] {
  const byText = new Map(facts.map((f) => [f.text.trim().toLowerCase(), f]));
  const now = new Date().toISOString();
  const out: MemoryFact[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // drop exact duplicate outputs
    seen.add(key);
    const existing = byText.get(key);
    if (existing) {
      out.push(existing); // preserve id + counters → vector stays valid
    } else {
      out.push({ id: randomUUID(), text, source: 'consolidated', createdAt: now, updatedAt: now, accessCount: 0, lastAccessed: now });
    }
  }
  return out;
}

const DREAM_SYSTEM = `You consolidate a personal assistant's long-term memory.
You are given facts the assistant recorded. Return ONLY a JSON array of strings — the single best consolidated fact list.
Rules:
- Merge near-duplicates into one precise fact.
- If facts contradict, keep the most recent one (it is usually stated on the right; if timestamps are equal, keep the most specific).
- Discard ephemera: greetings, counts, transient "current state" notes, idle chatter.
- PRESERVE durable facts: the user's preferences, names, decisions, commitments, appointments, and architecture/technical facts.
- Never invent facts that are not in the input. Do not add explanation, markdown, or commentary — only the JSON array.
If nothing is worth keeping, return: []`;

export async function shouldDream(
  lock: DreamLockFile,
  facts: MemoryFact[],
  opts: DreamOptions,
): Promise<{ go: boolean; reason: string }> {
  if (opts.enabled === false) return { go: false, reason: 'dream disabled' };
  const last = await lock.lastConsolidatedAt();
  const minHours = opts.minHours ?? 6;
  if (last && Date.now() - last < minHours * 3600_000) {
    return { go: false, reason: `consolidated ${Math.max(0, Math.round((Date.now() - last) / 3600_000))}h ago (< ${minHours}h)` };
  }
  const minAgeMs = opts.minAgeMs ?? 5 * 60_000;
  const mature = facts.filter((f) => !Number.isFinite(Date.parse(f.createdAt)) || Date.now() - Date.parse(f.createdAt) >= minAgeMs);
  const minCount = opts.minCount ?? 5;
  if (mature.length < minCount) {
    return { go: false, reason: `only ${mature.length} mature facts (< ${minCount})` };
  }
  return { go: true, reason: 'ready' };
}

/**
 * Run one consolidation pass. Returns `{ ran:false, reason }` when gates or a
 * lock pre-empt it, or `{ ran:true, before, after, dropped }` when the store
 * was rewritten. Never throws on a model/network error — it fails open.
 */
export async function runDream(
  memory: Memory,
  router: ModelRouter,
  config: JarvGenieConfig,
  opts: DreamOptions = {},
): Promise<DreamResult> {
  const lock = new DreamLockFile(path.join(config.memory.dir, LOCK_FILE));

  const facts = await memory.factStore.list();
  const gate = await shouldDream(lock, facts, opts);
  if (!gate.go) return { ran: false, reason: gate.reason };

  const staleMs = (opts.minHours ?? 6) * 3600_000;
  if (!(await lock.acquire(staleMs))) {
    return { ran: false, reason: 'another dream is already in progress' };
  }
  try {
    return await doConsolidation(memory, router, facts, opts, lock);
  } finally {
    await lock.release();
  }
}

async function doConsolidation(
  memory: Memory,
  router: ModelRouter,
  facts: MemoryFact[],
  opts: DreamOptions,
  lock: DreamLockFile,
): Promise<DreamResult> {
  const minAgeMs = opts.minAgeMs ?? 5 * 60_000;
  const mature = facts.filter((f) => !Number.isFinite(Date.parse(f.createdAt)) || Date.now() - Date.parse(f.createdAt) >= minAgeMs);
  const maxInput = opts.maxInputChars ?? 32_000;
  const bundle = mature.map((f, i) => `- [${i}] ${f.text}`).join('\n');
  const truncated = bundle.length > maxInput ? bundle.slice(0, maxInput) + '\n[truncated]' : bundle;

  const user = `Consolidate these facts:\n\n${truncated}\n\nReturn only the JSON array of consolidated fact strings.`;

  let raw = '';
  try {
    const chat = await router.chat({
      messages: [
        { role: 'system', content: DREAM_SYSTEM },
        { role: 'user', content: user },
      ],
    });
    raw = (chat.content ?? '').trim();
  } catch (err) {
    return { ran: false, reason: `model unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const texts = parseJsonArray(raw);
  if (!texts) {
    return { ran: false, reason: 'model returned invalid JSON — store untouched (fail-open)' };
  }

  // Consolidate everything into a new fact list (preserving ids of unchanged facts).
  const newFacts = mergeConsolidated(facts, texts);
  const { dropped } = await memory.consolidateTo(newFacts);
  await lock.stamp();
  return { ran: true, before: facts.length, after: newFacts.length, dropped };
}

/** Tolerantly parse a JSON array of strings from the model's reply, which may
 *  arrive wrapped in markdown fences or with stray prose. */
export function parseJsonArray(raw: string): string[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced && fenced[1] ? fenced[1] : raw).trim();
  // Find the outermost [ ... ].
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
    return null;
  } catch {
    return null;
  }
}
