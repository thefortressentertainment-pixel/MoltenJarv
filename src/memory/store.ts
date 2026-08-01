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

  async add(text: string, source = 'user'): Promise<MemoryFact> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const fact: MemoryFact = { id: randomUUID(), text, source, createdAt: now, updatedAt: now };
    this.facts.push(fact);
    await this.save();
    return fact;
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
}
