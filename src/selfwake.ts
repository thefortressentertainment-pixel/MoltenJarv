import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Self-wake — agent-initiated suspend/resume, adapted from andrewyng/openworker's
 * `coworker/selfwake.py` (MIT).
 *
 * An always-on agent becomes event-driven: instead of idling, it can declare
 * "wake me later" (sleep_until) or "wake me when this background job finishes"
 * (wake_on_job). A persisted WakeStore tracks `pending → due → fired`; the
 * scheduler's tick (see `pollDue`) fans the due ones back into `fired` so the
 * agent re-runs without burning context while asleep.
 */

export interface WakeRecord {
  id: string;
  /** When the wake becomes due (epoch ms). */
  dueAt: number;
  /** The prompt/hint to re-inject when it fires. */
  prompt: string;
  /** Optional job handle this wake is tied to (e.g. a background pid/task id). */
  job?: string;
  status: 'pending' | 'fired';
  createdAt: string;
}

const WAKE_FILE = 'selfwake.json';

export class WakeStore {
  private records: WakeRecord[] = [];
  private loaded = false;
  private readonly file: string;

  constructor(private dir: string) {
    this.file = path.join(dir, WAKE_FILE);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as WakeRecord[];
      this.records = Array.isArray(raw) ? raw : [];
    } catch {
      this.records = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.records, null, 2) + '\n');
  }

  /** Schedule a wake; returns its id. A later dueAt for the same prompt+job is deduped. */
  async schedule(prompt: string, dueAt: number, job?: string): Promise<string> {
    await this.ensureLoaded();
    if (job) {
      const existing = this.records.find((r) => r.job === job && r.status === 'pending');
      if (existing) return existing.id;
    }
    const record: WakeRecord = {
      id: `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      dueAt,
      prompt,
      ...(job ? { job } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    await this.save();
    return record.id;
  }

  /** Cancel a pending wake. Returns true if one was removed. */
  async cancel(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.records.length;
    this.records = this.records.filter((r) => !(r.id === id && r.status === 'pending'));
    const changed = this.records.length !== before;
    if (changed) await this.save();
    return changed;
  }

  /** All due (and not yet fired) wakes, oldest dueAt first. */
  async due(now = Date.now()): Promise<WakeRecord[]> {
    await this.ensureLoaded();
    return this.records.filter((r) => r.status === 'pending' && r.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Mark due wakes as fired and return them (the scheduler re-runs the agent). */
  async pollDue(now = Date.now()): Promise<WakeRecord[]> {
    await this.ensureLoaded();
    const fired = this.records.filter((r) => r.status === 'pending' && r.dueAt <= now);
    if (fired.length === 0) return [];
    for (const r of fired) r.status = 'fired';
    await this.save();
    return fired.sort((a, b) => a.dueAt - b.dueAt);
  }

  async list(): Promise<WakeRecord[]> {
    await this.ensureLoaded();
    return [...this.records].sort((a, b) => b.dueAt - a.dueAt);
  }
}
