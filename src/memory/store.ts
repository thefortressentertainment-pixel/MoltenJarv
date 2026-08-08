import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryFact } from './types.js';

/** Durable fact store persisted as JSON at a single file path. */
export class FactStore {
  private facts: MemoryFact[] = [];
  private loaded = false;

  constructor(private file: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.facts = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.facts = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.facts, null, 2) + '\n');
  }

  async add(text: string, source = 'user', summary?: string): Promise<MemoryFact> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const fact: MemoryFact = { id: randomUUID(), text, source, createdAt: now, updatedAt: now, accessCount: 0, lastAccessed: now, ...(summary ? { summary } : {}) };
    this.facts.push(fact);
    await this.save();
    return fact;
  }

  /** Update-don't-duplicate: replace a fact's text (and optional summary) by id,
   *  bumping the updated timestamp. Returns the updated fact, or undefined if the
   *  id is unknown. */
  async update(id: string, text: string, summary?: string): Promise<MemoryFact | undefined> {
    await this.ensureLoaded();
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return undefined;
    const now = new Date().toISOString();
    fact.text = text;
    fact.updatedAt = now;
    if (summary !== undefined) fact.summary = summary;
    else delete fact.summary;
    await this.save();
    return { ...fact };
  }

  /** Increment the rehearsal counters for the given fact ids. Silently ignores
   *  unknown/missing ids. Returns the updated facts. */
  async recordAccess(ids: string[]): Promise<MemoryFact[]> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    let changed = false;
    const touched: MemoryFact[] = [];
    for (const id of ids) {
      const fact = this.facts.find((f) => f.id === id);
      if (!fact) continue;
      fact.accessCount = (fact.accessCount ?? 0) + 1;
      fact.lastAccessed = now;
      fact.updatedAt = now;
      touched.push(fact);
      changed = true;
    }
    if (changed) await this.save();
    return touched;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    const changed = this.facts.length !== before;
    if (changed) await this.save();
    return changed;
  }

  async list(): Promise<MemoryFact[]> {
    await this.ensureLoaded();
    return [...this.facts];
  }

  async get(id: string): Promise<MemoryFact | undefined> {
    await this.ensureLoaded();
    return this.facts.find((f) => f.id === id);
  }

  /** Replace the entire fact list (used by dream consolidation). Ids not in the
   *  new list are dropped; ids preserved keep their vectors valid. */
  async replaceAll(facts: MemoryFact[]): Promise<void> {
    await this.ensureLoaded();
    this.facts = facts;
    await this.save();
  }
}
