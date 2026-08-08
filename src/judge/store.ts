import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewEntry } from './types.js';

/**
 * Persistent taste/review log persisted as JSON at a single file path
 * (mirrors src/memory/store.ts). Append-only journal of Jarv's self-reviews,
 * so self-optimization becomes measurable: a low/decomposed score says *which*
 * component failed, and a persisted trend says whether Jarv got better.
 */
export class ReviewStore {
  private entries: ReviewEntry[] = [];
  private loaded = false;

  constructor(private file: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.entries, null, 2) + '\n');
  }

  /** Append a review. Entry is stamped with an id and ts when absent. */
  async add(input: Omit<ReviewEntry, 'id' | 'ts'> & { id?: string; ts?: string }): Promise<ReviewEntry> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const entry: ReviewEntry = {
      id: input.id ?? randomUUID(),
      ts: input.ts ?? now,
      kind: input.kind,
      ...(input.label ? { label: input.label } : {}),
      compliance: input.compliance,
      completeness: input.completeness,
      judgeScore: input.judgeScore,
      total: input.total,
      fatal: input.fatal,
      ...(input.inconclusive ? { inconclusive: input.inconclusive } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    this.entries.push(entry);
    await this.save();
    return entry;
  }

  /** Get a review by id. Returns undefined when unknown. */
  async get(id: string): Promise<ReviewEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.find((e) => e.id === id);
  }

  /** All reviews, oldest first. */
  async list(): Promise<ReviewEntry[]> {
    await this.ensureLoaded();
    return [...this.entries];
  }

  /** Number of recorded reviews. */
  async count(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.length;
  }

  /** Reject a review by id (journal integrity / a mis-recorded entry). */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const changed = this.entries.length !== before;
    if (changed) await this.save();
    return changed;
  }

  /** The most recent review, oldest-first order. */
  private async latest(): Promise<ReviewEntry | undefined> {
    await this.ensureLoaded();
    return this.entries[this.entries.length - 1];
  }

  /**
   * The signed delta between the two most recent reviews' totals (null when
   * fewer than two exist). A positive value means the latest review scored
   * higher than the one before it. `self_review` surfaces this as a trend.
   */
  async totalDelta(): Promise<number | null> {
    await this.ensureLoaded();
    if (this.entries.length < 2) return null;
    const prev = this.entries[this.entries.length - 2]!;
    const last = this.entries[this.entries.length - 1]!;
    return last.total - prev.total;
  }

  /**
   * A compact summary for surfacing in self_review: count + latest total +
   * signed delta vs the previous review (null when <2 entries).
   */
  async summary(): Promise<{ count: number; latest?: { id: string; ts: string; total: number }; delta: number | null }> {
    await this.ensureLoaded();
    const last = await this.latest();
    const delta = last ? await this.totalDelta() : null;
    return {
      count: this.entries.length,
      latest: last ? { id: last.id, ts: last.ts, total: last.total } : undefined,
      delta,
    };
  }
}
