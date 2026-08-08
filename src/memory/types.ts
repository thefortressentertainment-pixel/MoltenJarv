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
}
