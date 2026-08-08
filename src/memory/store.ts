import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryFact } from './types.js';

/** Add fields accepted when creating a fact (GRAPH temporal/provenance/triplet). */
export interface FactInput {
  source?: string;
  summary?: string;
  validFrom?: string;
  validTo?: string;
  provenance?: string;
  subject?: string;
  relationship?: string;
  object?: string;
}

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

  async add(text: string, input?: FactInput | string): Promise<MemoryFact>;
  async add(text: string, source?: string, summary?: string): Promise<MemoryFact>;
  async add(text: string, input?: FactInput | string): Promise<MemoryFact> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const src = typeof input === 'string' ? input : (input?.source ?? 'user');
    const meta = typeof input === 'string' ? {} : (input ?? {});
    const fact: MemoryFact = {
      id: randomUUID(),
      text,
      source: src,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      ...(meta.summary ? { summary: meta.summary } : {}),
      ...(meta.validFrom ? { validFrom: meta.validFrom } : { validFrom: now }),
      ...(meta.validTo ? { validTo: meta.validTo } : {}),
      ...(meta.provenance ? { provenance: meta.provenance } : {}),
      ...(meta.subject ? { subject: meta.subject } : {}),
      ...(meta.relationship ? { relationship: meta.relationship } : {}),
      ...(meta.object ? { object: meta.object } : {}),
    };
    this.facts.push(fact);
    await this.save();
    return fact;
  }

  /**
   * GRAPH temporal-supersede: replace a fact's text by id WITHOUT deleting the
   * old one. The old fact is marked `validTo = now` (retained for history) and a
   * NEW currently-valid fact is created with the new text. Returns the new fact,
   * or undefined if the id is unknown. Optional triplet/provenance/validFrom
   * fields on the replacement are carried from `input`.
   */
  async update(id: string, text: string, input?: FactInput): Promise<MemoryFact | undefined> {
    await this.ensureLoaded();
    const old = this.facts.find((f) => f.id === id);
    if (!old) return undefined;
    const now = new Date().toISOString();

    // Advance validity on the superseded fact (do NOT overwrite its text).
    if (!old.validTo) old.validTo = now;
    old.updatedAt = now;

    // Retain existing triplet/provenance/summary unless the caller overrides.
    const meta = input ?? {};
    const replacement: MemoryFact = {
      id: randomUUID(),
      text,
      source: old.source,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      summary: meta.summary ?? old.summary,
      validFrom: meta.validFrom ?? now,
      ...(meta.validTo ? { validTo: meta.validTo } : {}),
      provenance: meta.provenance ?? old.provenance,
      subject: meta.subject ?? old.subject,
      relationship: meta.relationship ?? old.relationship,
      object: meta.object ?? old.object,
    };
    this.facts.push(replacement);
    await this.save();
    return replacement;
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

  /** Facts currently in effect — `validTo` unset (never superseded) or in the
   *  future. GRAPH's "what's true now". */
  async validFacts(now = Date.now()): Promise<MemoryFact[]> {
    await this.ensureLoaded();
    const t = new Date(now).getTime();
    return this.facts.filter((f) => {
      if (f.validTo) {
        const v = Date.parse(f.validTo);
        if (Number.isFinite(v) && v <= t) return false;
      }
      return true;
    });
  }

  /** Superseded (historical) facts — `validTo` set in the past. GRAPH's
   *  "what was true". */
  async historicalFacts(now = Date.now()): Promise<MemoryFact[]> {
    await this.ensureLoaded();
    const t = new Date(now).getTime();
    return this.facts.filter((f) => {
      if (!f.validTo) return false;
      const v = Date.parse(f.validTo);
      return Number.isFinite(v) && v <= t;
    });
  }

  /** Facts whose entity triplet subject (or object) matches, enabling
   *  subject-scoped / traversal recall (GRAPH "traverse from user"). */
  async factsForSubject(subject: string): Promise<MemoryFact[]> {
    await this.ensureLoaded();
    const s = subject.trim().toLowerCase();
    if (!s) return [];
    return this.facts.filter(
      (f) => f.subject?.toLowerCase() === s || f.object?.toLowerCase() === s,
    );
  }

  /** Replace the entire fact list (used by dream consolidation). Ids not in the
   *  new list are dropped; ids preserved keep their vectors valid. */
  async replaceAll(facts: MemoryFact[]): Promise<void> {
    await this.ensureLoaded();
    this.facts = facts;
    await this.save();
  }
}
