import path from 'node:path';
import type { ChatMessage, MemoryService } from '../agent/types.js';
import { resolveEmbeddingsConfig, type JarvGenieConfig } from '../config/index.js';
import { EmbeddingClient } from './embeddings.js';
import { SemanticSearch, VectorCache } from './search.js';
import { SessionStore } from './sessions.js';
import { FactStore } from './store.js';

/** Facade over facts, sessions, and search. Implements MemoryService for the agent. */
export class Memory implements MemoryService {
  readonly embeddings: EmbeddingClient | null;

  constructor(
    private store: FactStore,
    private sessions: SessionStore,
    private search: SemanticSearch,
    embeddings: EmbeddingClient | null,
  ) {
    this.embeddings = embeddings;
  }

  async addFact(text: string, source = 'user'): Promise<{ id: string }> {
    const fact = await this.store.add(text, source);
    return { id: fact.id };
  }

  async recall(query: string, opts?: { k?: number; threshold?: number }): Promise<Array<{ id: string; text: string; score: number; rawScore?: number }>> {
    const facts = await this.store.list();
    const hits = await this.search.search(query, facts, opts?.k ?? 5, opts?.threshold ?? 0.2);
    // Rehearsal: every surfaced fact is a retrieval event that strengthens it.
    if (hits.length > 0) {
      void this.store.recordAccess(hits.map((h) => h.fact.id));
    }
    return hits.map((h) => ({ id: h.fact.id, text: h.fact.text, score: h.score, rawScore: h.rawScore }));
  }

  async listFacts(): Promise<Array<{ id: string; text: string; createdAt: string }>> {
    const facts = await this.store.list();
    return facts.map((f) => ({ id: f.id, text: f.text, createdAt: f.createdAt }));
  }

  async deleteFact(id: string): Promise<boolean> {
    await this.search.deleteVector(id);
    return this.store.remove(id);
  }

  /** The underlying fact store (dream consolidation runs against it). */
  get factStore(): FactStore {
    return this.store;
  }

  /** The embedding-backed search index (dream prunes vectors for dropped facts). */
  get searchIndex(): SemanticSearch {
    return this.search;
  }

  /** Replace the fact list atomically, pruning embedding vectors for facts that
   *  no longer exist. Ids retained keep their vectors valid. Returns the number
   *  of facts dropped. */
  async consolidateTo(facts: Array<{ id: string; text: string; source: string; createdAt: string; updatedAt: string }>): Promise<{ dropped: number }> {
    const current = await this.store.list();
    const keptIds = new Set(facts.map((f) => f.id));
    const dropped = current.filter((f) => !keptIds.has(f.id));
    for (const fact of dropped) {
      await this.search.deleteVector(fact.id);
    }
    await this.store.replaceAll(facts);
    return { dropped: dropped.length };
  }

  async sessionLoad(sessionId: string): Promise<ChatMessage[]> {
    return this.sessions.load(sessionId);
  }

  async sessionAppend(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.sessions.append(sessionId, messages);
  }

  async sessionReset(sessionId: string): Promise<void> {
    await this.sessions.reset(sessionId);
  }
}

export function buildMemory(config: JarvGenieConfig): Memory {
  const embedCfg = resolveEmbeddingsConfig(config);
  const embeddings = embedCfg ? new EmbeddingClient(embedCfg) : null;
  const cache = new VectorCache(path.join(config.memory.dir, 'facts.vectors.json'));
  const search = new SemanticSearch(embeddings, cache);
  const store = new FactStore(path.join(config.memory.dir, 'facts.json'));
  const sessions = new SessionStore(path.join(config.memory.dir, 'sessions'));
  return new Memory(store, sessions, search, embeddings);
}
