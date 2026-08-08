export interface MemoryFact {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  /** A one-line gist written at save time, used for compact two-tier recall. */
  summary?: string;
  /** How many times recall has surfaced this fact (rehearsal signal). */
  accessCount?: number;
  /** ISO timestamp of the last time recall surfaced this fact. */
  lastAccessed?: string;
  /**
   * Temporal validity window (GRAPH / graphiti "context graph" pattern, Apache-2.0).
   * `validFrom`: ISO when this truth began (default = createdAt).
   * `validTo`:   ISO when it was superseded (only set on older/historical facts);
   *              unset means the fact is *currently valid*. A superseded fact is
   *              retained for history, never deleted — "what was true then".
   */
  validFrom?: string;
  validTo?: string;
  /**
   * Provenance/episode: the raw trace that produced this fact (an utterance, a
   * verified task run, a source doc). Full lineage from derived fact → input.
   */
  provenance?: string;
  /**
   * Entity triplet (Entity → Relationship → Entity), GRAPH-style, enabling
   * subject/object-scoped recall and graph traversal over flat embedding search:
   * e.g. { subject: 'user', relationship: 'prefers', object: 'dark mode' }.
   */
  subject?: string;
  relationship?: string;
  object?: string;
}

