import fs from 'node:fs/promises';
import path from 'node:path';
import { EmbeddingClient } from './embeddings.js';
import type { MemoryFact } from './types.js';

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SearchHit {
  fact: MemoryFact;
  score: number;
}

/** Persistent cache of fact id -> embedding vector. */
export class VectorCache {
  private map = new Map<string, number[]>();
  private loaded = false;

  constructor(private file: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, number[]>;
      for (const [id, vec] of Object.entries(parsed)) if (Array.isArray(vec)) this.map.set(id, vec);
    } catch {
      // no cache yet
    }
    this.loaded = true;
  }

  async get(id: string): Promise<number[] | undefined> {
    await this.ensureLoaded();
    return this.map.get(id);
  }

  async set(id: string, vec: number[]): Promise<void> {
    await this.ensureLoaded();
    this.map.set(id, vec);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)) + '\n');
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    if (this.map.delete(id)) {
      await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)) + '\n');
    }
  }
}

export function keywordSearch(query: string, facts: MemoryFact[], k = 5): SearchHit[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const q = query.toLowerCase();
  const scored: SearchHit[] = facts.map((fact) => {
    const text = fact.text.toLowerCase();
    const tokenHits = tokens.filter((t) => text.includes(t)).length;
    const subHit = q.length > 2 && text.includes(q) ? 1 : 0;
    const score = (tokenHits / Math.max(1, tokens.length)) * 0.8 + subHit * 0.2;
    return { fact, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Semantic search with graceful fallback to keyword matching when embeddings are unavailable. */
export class SemanticSearch {
  constructor(private embed: EmbeddingClient | null, private cache: VectorCache) {}

  get embeddingsEnabled(): boolean {
    return this.embed !== null && this.embed.enabled;
  }

  async search(query: string, facts: MemoryFact[], k = 5, threshold = 0.2): Promise<SearchHit[]> {
    if (!this.embed || !this.embed.enabled) return keywordSearch(query, facts, k);

    const vectors = new Map<string, number[]>();
    const missing: MemoryFact[] = [];
    for (const fact of facts) {
      const vec = await this.cache.get(fact.id);
      if (vec) vectors.set(fact.id, vec);
      else missing.push(fact);
    }
    if (missing.length > 0) {
      try {
        const embedded = await this.embed.embed(missing.map((f) => f.text));
        for (let i = 0; i < missing.length; i++) {
          const vec = embedded[i];
          if (vec) {
            vectors.set(missing[i]!.id, vec);
            void this.cache.set(missing[i]!.id, vec);
          }
        }
      } catch {
        return keywordSearch(query, facts, k);
      }
    }

    let queryVec: number[] | undefined;
    try {
      [queryVec] = await this.embed.embed([query]);
    } catch {
      return keywordSearch(query, facts, k);
    }
    if (!queryVec) return keywordSearch(query, facts, k);

    const scored: SearchHit[] = [];
    for (const fact of facts) {
      const vec = vectors.get(fact.id);
      if (!vec || vec.length !== queryVec.length) continue;
      scored.push({ fact, score: cosineSimilarity(queryVec, vec) });
    }
    return scored.filter((s) => s.score >= threshold).sort((a, b) => b.score - a.score).slice(0, k);
  }

  async deleteVector(id: string): Promise<void> {
    await this.cache.delete(id);
  }
}
