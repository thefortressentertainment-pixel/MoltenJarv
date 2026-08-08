import fs from 'node:fs/promises';
import path from 'node:path';
import { EmbeddingClient } from './embeddings.js';
import type { MemoryFact } from './types.js';

/** Return true when a fact is "evergreen" — never time-decayed. Sources like
 *  user/global/workspace are curated long-term truths; only transient sources
 *  (session, logs, etc.) decay with age. Mirrors grok-build's evergreen
 *  exemption for global/workspace scopes. */
function isEvergreen(fact: MemoryFact): boolean {
  const src = (fact.source ?? '').toLowerCase();
  if (!src) return true; // legacy facts without a source default to evergreen
  return !['session', 'session_log', 'log', 'transient'].includes(src);
}

/** Exponential half-life decay, matching grok-build (search.rs):
 *  `e^(−ln2/halfLifeDays × ageDays)`. Evergreen facts never decay. */
function temporalDecay(fact: MemoryFact, halfLifeDays = 30): number {
  if (isEvergreen(fact)) return 1;
  const created = Date.parse(fact.createdAt);
  if (!Number.isFinite(created)) return 1; // unparseable date → don't decay
  const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
  return Math.exp((-Math.LN2 / halfLifeDays) * ageDays);
}

/** Access-frequency boost, matching grok-build (search.rs):
 *  `1 + ln(1+count) × 0.05`. Sublinear; rewards rehearsed facts. */
function accessBoost(fact: MemoryFact): number {
  const count = fact.accessCount ?? 0;
  return 1 + Math.log(1 + count) * 0.05;
}

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
  /** Clamped [0,1] score shown to clients. */
  score: number;
  /** Unbounded score used for ranking (kept separate so boosts never clamp
   *  invisibly — equals the grok-build raw/display split). */
  rawScore: number;
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

/** Lexical overlap score (shared by keyword search and MMR similarity). Lowercase
 *  token Jaccard on alphanumeric tokens; no embeddings needed. */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0));
  const tb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Keyword-only scoring over facts. Each hit carries an unclamped `rawScore` so
 *  callers can rank before clamping to `score`. */
export function keywordSearch(query: string, facts: MemoryFact[], k = 5): SearchHit[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const q = query.toLowerCase();
  const raw: Array<{ fact: MemoryFact; raw: number }> = facts.map((fact) => {
    const text = fact.text.toLowerCase();
    const tokenHits = tokens.filter((t) => text.includes(t)).length;
    const subHit = q.length > 2 && text.includes(q) ? 1 : 0;
    const raw = (tokenHits / Math.max(1, tokens.length)) * 0.8 + subHit * 0.2;
    return { fact, raw };
  });
  const scored: SearchHit[] = raw.map(({ fact, raw }) => ({ fact, rawScore: raw, score: clamp(raw) }));
  return scored.filter((s) => s.rawScore > 0).sort((a, b) => b.rawScore - a.rawScore).slice(0, k);
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Semantic + lexical hybrid search with graceful fallback when embeddings are
 *  unavailable. Implements grok-build's hybrid fusion, temporal decay, and
 *  access-boost scoring; optionally an MMR diversity re-rank. */
export class SemanticSearch {
  constructor(
    private embed: EmbeddingClient | null,
    private cache: VectorCache,
    private opts?: { halfLifeDays?: number; mmrLambda?: number },
  ) {}

  get embeddingsEnabled(): boolean {
    return this.embed !== null && this.embed.enabled;
  }

  async deleteVector(id: string): Promise<void> {
    await this.cache.delete(id);
  }

  /** Run over all facts (the full corpus); MMR needs the whole candidate pool. */
  async search(query: string, facts: MemoryFact[], k = 5, threshold = 0.2): Promise<SearchHit[]> {
    const candidates = await this.scoreAll(query, facts, threshold);
    let ranked = candidates.sort((a, b) => b.rawScore - a.rawScore).slice(0, Math.max(k, 6));

    const mmrLambda = this.opts?.mmrLambda ?? 0.6;
    if (mmrLambda < 1 && ranked.length > 1) {
      ranked = mmrRerank(query, ranked, mmrLambda);
    }
    return ranked.slice(0, k);
  }

  /** Hybrid scoring over the whole corpus: keyword score via lexical overlap,
   *  vector score via cosine, fused with `max(weighted, fts)` per grok-build, then
   *  temporal decay and access boost. Returns entries with re-ordered ranking. */
  private async scoreAll(query: string, facts: MemoryFact[], threshold: number): Promise<SearchHit[]> {
    // Phase 1: lexical scores (always available).
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    const q = query.toLowerCase();
    const lexical = new Map<string, number>();
    for (const fact of facts) {
      const text = fact.text.toLowerCase();
      if (tokens.length === 0) { lexical.set(fact.id, 0); continue; }
      const tokenHits = tokens.filter((t) => text.includes(t)).length;
      const subHit = q.length > 2 && text.includes(q) ? 1 : 0;
      lexical.set(fact.id, clamp((tokenHits / tokens.length) * 0.8 + subHit * 0.2));
    }

    // Phase 2: vector scores (bounded timeout/graceful fallback).
    const vector = new Map<string, number>();
    if (this.embed?.enabled) {
      try {
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
            // embedding unavailable → keep only what we already loaded
          }
        }
        let queryVec: number[] | undefined;
        try {
          [queryVec] = await this.embed.embed([query]);
        } catch {
          queryVec = undefined;
        }
        if (queryVec) {
          for (const fact of facts) {
            const vec = vectors.get(fact.id);
            if (vec && vec.length === queryVec.length) {
              vector.set(fact.id, Math.max(0, cosineSimilarity(queryVec, vec)));
            }
          }
        }
      } catch {
        // vector pipeline failed → hybrid falls back to lexical only
      }
    }

    const useVector = vector.size > 0;
    const halfLifeDays = this.opts?.halfLifeDays ?? 30;
    const FTS_W = 0.6;
    const VEC_W = 0.4;
    const alpha = useVector ? FTS_W : 1;
    const beta = useVector ? VEC_W : 0;

    const out: SearchHit[] = [];
    for (const fact of facts) {
      const fts = lexical.get(fact.id) ?? 0;
      const vec = vector.get(fact.id) ?? 0;
      // grok-build hybrid fusion rule: combined never below the FTS score alone,
      // so a strong keyword hit can't be drowned by vector noise.
      const rawBase = useVector ? Math.max(alpha * fts + beta * vec, fts) : fts;
      // Temporal decay (evergreen exempt) × access-frequency boost.
      const raw = rawBase * temporalDecay(fact, halfLifeDays) * accessBoost(fact);
      if (raw < threshold) continue;
      out.push({ fact, rawScore: raw, score: clamp(raw) });
    }
    return out;
  }
}

/** Diversity re-rank (MMR), modeled on grok-build's mmr.rs. Relevance = the
 *  unclamped raw score; similarity = token-Jaccard (no embeddings). Maximizes
 *  `λ·relevance − (1−λ)·maxSimilarity(selected)`. */
export function mmrRerank(query: string, candidates: SearchHit[], lambda = 0.6): SearchHit[] {
  const selected: SearchHit[] = [];
  const remaining = [...candidates];
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0));

  // First pick = highest raw score (mirrors grok-build's greedy start).
  let firstIdx = 0;
  let firstBest = -Infinity;
  for (let i = 0; i < remaining.length; i++) {
    const r = remaining[i]!.rawScore;
    if (r > firstBest) { firstBest = r; firstIdx = i; }
  }
  selected.push(remaining.splice(firstIdx, 1)[0]!);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      const relevance = cand.rawScore;
      // query similarity counts toward diversity (penalize re-stating the query)
      let maxSim = queryTokens.size > 0 ? tokenJaccard(cand.fact.text, query) : 0;
      for (const s of selected) {
        const sim = tokenJaccard(cand.fact.text, s.fact.text);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected;
}
